import type { ConnectFn } from "../src/smtp/smtp-client";

type Socket = ReturnType<ConnectFn>;

export interface FakeSmtp {
  connect: ConnectFn;
  /** Every command line received, in order (DATA payload excluded). */
  commands: string[];
  /** The DATA payload, with CRLF line endings, without the terminating ".". */
  data: string;
  upgraded: boolean;
  connections: { address: unknown; options: unknown }[];
}

/**
 * A scripted SMTP server. `overrides` maps a command verb (e.g. "RCPT", "AUTH") to the reply line to send instead
 * of the happy-path reply. The special value "SILENT" sends no reply.
 */
export function fakeSmtp(overrides: Record<string, string> = {}): FakeSmtp {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let pending = "";
  let inData = false;
  let authLoginStep = 0;

  const reply = (line: string): string => {
    if (authLoginStep === 1) {
      authLoginStep = 2;
      return "334 UGFzc3dvcmQ6";
    }
    if (authLoginStep === 2) {
      authLoginStep = 0;
      return "235 ok";
    }
    const verb = line.split(" ")[0].toUpperCase();
    if (overrides[verb]) return overrides[verb];
    switch (verb) {
      case "EHLO":
        return "250-smtp.test\r\n250 AUTH PLAIN LOGIN";
      case "STARTTLS":
        return "220 ready";
      case "AUTH":
        if (line === "AUTH LOGIN") {
          authLoginStep = 1;
          return "334 VXNlcm5hbWU6";
        }
        return "235 ok";
      case "MAIL":
      case "RCPT":
        return "250 ok";
      case "DATA":
        inData = true;
        return "354 go ahead";
      case "QUIT":
        return "221 bye";
      default:
        return "500 unknown command";
    }
  };

  const state: FakeSmtp = { connect: undefined as unknown as ConnectFn, commands: [], data: "", upgraded: false, connections: [] };

  const makeSocket = (greet: boolean): Socket => {
    let out!: ReadableStreamDefaultController<Uint8Array>;
    const push = (text: string) => out.enqueue(encoder.encode(`${text}\r\n`));
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        out = controller;
        if (greet) push("220 smtp.test ready");
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        pending += decoder.decode(chunk);
        let end: number;
        while ((end = pending.indexOf("\r\n")) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              push("250 queued");
            } else {
              state.data += `${line}\r\n`;
            }
            continue;
          }
          state.commands.push(line);
          const answer = reply(line);
          if (answer !== "SILENT") push(answer);
        }
      },
    });
    const socket = {
      readable,
      writable,
      close: async () => {
        try {
          out.close();
        } catch {
          // already closed
        }
      },
      startTls: () => {
        state.upgraded = true;
        return makeSocket(false);
      },
    };
    return socket as unknown as Socket;
  };

  state.connect = ((address: unknown, options: unknown) => {
    state.connections.push({ address, options });
    return makeSocket(true);
  }) as ConnectFn;
  return state;
}

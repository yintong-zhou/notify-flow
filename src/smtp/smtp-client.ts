import { connect } from "cloudflare:sockets";
import type { SmtpConfig } from "./provider";

export type ConnectFn = typeof connect;
type Socket = ReturnType<ConnectFn>;

export interface MailMessage {
  from: string;
  fromName: string;
  to: string;
  messageId: string;
  subject: string;
  html: string;
  text: string;
}

export type SendMailFn = (config: SmtpConfig, message: MailMessage) => Promise<void>;

export type SmtpErrorCode =
  | "smtp_connection_failed"
  | "smtp_timeout"
  | "smtp_temporary_failure"
  | "smtp_auth_failed"
  | "smtp_rejected";

export class SmtpError extends Error {
  readonly code: SmtpErrorCode;
  readonly transient: boolean;

  /** `message` must never include SMTP reply text: it may contain the recipient address. */
  constructor(code: SmtpErrorCode, transient: boolean, message: string) {
    super(message);
    this.code = code;
    this.transient = transient;
  }
}

const encoder = new TextEncoder();

export function base64(value: string): string {
  const bytes = encoder.encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const wrap76 = (value: string): string => value.match(/.{1,76}/g)?.join("\r\n") ?? "";
const crlf = (value: string): string => value.replace(/\r?\n/g, "\r\n");
const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1);

/** RFC 2047 encoded words of at most 45 UTF-8 bytes (≤ 72 chars each), folded onto continuation lines. */
function encodeWords(value: string): string {
  const words: string[] = [];
  let current = "";
  let size = 0;
  for (const char of value) {
    const n = encoder.encode(char).length;
    if (size + n > 45) {
      words.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += n;
  }
  if (current) words.push(current);
  return words.map((w) => `=?UTF-8?B?${base64(w)}?=`).join("\r\n ");
}

export const dotStuff = (data: string): string => data.replace(/^\./gm, "..");

export function buildMessage(msg: MailMessage, date = new Date()): string {
  const boundary = `nf_${crypto.randomUUID()}`;
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", wrap76(base64(crlf(body)))].join(
      "\r\n",
    );
  return [
    `From: ${msg.fromName ? `${encodeWords(msg.fromName)} ` : ""}<${msg.from}>`,
    `To: <${msg.to}>`,
    `Subject: ${encodeWords(msg.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${msg.messageId}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    part("text/plain", msg.text),
    part("text/html", msg.html),
    `--${boundary}--`,
  ].join("\r\n");
}

class Connection {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly timeoutMs: number;
  private buffer = "";

  constructor(socket: Socket, timeoutMs: number) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.timeoutMs = timeoutMs;
  }

  async write(data: string): Promise<void> {
    await this.writer.write(encoder.encode(data));
  }

  /** Sends `line` (null = just read, for the greeting) and checks the reply code. */
  async command(line: string | null, expected: number[], auth = false): Promise<void> {
    if (line !== null) await this.write(`${line}\r\n`);
    const code = await this.withTimeout(this.readReply());
    if (expected.includes(code)) return;
    if (code >= 400 && code < 500) throw new SmtpError("smtp_temporary_failure", true, `SMTP ${code}`);
    throw new SmtpError(auth ? "smtp_auth_failed" : "smtp_rejected", false, `SMTP ${code}`);
  }

  release(): void {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }

  /** Reads one reply, skipping "250-..." continuation lines, and returns its code. */
  private async readReply(): Promise<number> {
    for (;;) {
      let end = this.buffer.indexOf("\r\n");
      while (end === -1) {
        const { value, done } = await this.reader.read();
        if (done) throw new SmtpError("smtp_connection_failed", true, "Connection closed by server");
        this.buffer += this.decoder.decode(value, { stream: true });
        end = this.buffer.indexOf("\r\n");
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      if (line[3] !== "-") return Number(line.slice(0, 3));
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SmtpError("smtp_timeout", true, "SMTP command timed out")), this.timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

export async function sendMail(
  config: SmtpConfig,
  msg: MailMessage,
  connectFn: ConnectFn = connect,
  timeoutMs = 10_000,
): Promise<void> {
  let socket: Socket;
  try {
    socket = connectFn(
      { hostname: config.host, port: config.port },
      { secureTransport: config.security === "tls" ? "on" : "starttls", allowHalfOpen: false },
    );
  } catch {
    throw new SmtpError("smtp_connection_failed", true, "Could not open the SMTP connection");
  }
  try {
    let conn = new Connection(socket, timeoutMs);
    const ehlo = `EHLO ${domainOf(config.from)}`;
    await conn.command(null, [220]);
    await conn.command(ehlo, [250]);
    if (config.security === "starttls") {
      await conn.command("STARTTLS", [220]);
      conn.release();
      socket = socket.startTls();
      conn = new Connection(socket, timeoutMs);
      await conn.command(ehlo, [250]);
    }
    if (config.authType === "plain") {
      await conn.command(`AUTH PLAIN ${base64(`\0${config.username}\0${config.password}`)}`, [235], true);
    } else {
      await conn.command("AUTH LOGIN", [334], true);
      await conn.command(base64(config.username), [334], true);
      await conn.command(base64(config.password), [235], true);
    }
    await conn.command(`MAIL FROM:<${msg.from}>`, [250]);
    await conn.command(`RCPT TO:<${msg.to}>`, [250, 251]);
    await conn.command("DATA", [354]);
    // ponytail: a timeout waiting for this final 250 is retried as transient, so a lost reply can duplicate the email;
    // inherent to SMTP without delivery tracking.
    await conn.command(`${dotStuff(buildMessage(msg))}\r\n.`, [250]);
    await conn.write("QUIT\r\n").catch(() => {});
  } catch (e) {
    if (e instanceof SmtpError) throw e;
    throw new SmtpError("smtp_connection_failed", true, "SMTP connection error");
  } finally {
    await socket.close().catch(() => {});
  }
}

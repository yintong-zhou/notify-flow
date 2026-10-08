import { env } from "cloudflare:workers";
import { handle } from "../src/index";
import type { MailMessage, SendMailFn } from "../src/smtp/smtp-client";
import type { Locale, Template } from "../src/types";

export async function createClient(name = "test-app"): Promise<{ id: string; key: string }> {
  const id = `cl_${crypto.randomUUID()}`;
  const key = `nf_${crypto.randomUUID()}`;
  // Hashed here independently of src/security/auth.ts, so auth tests also check the stored format (hex SHA-256).
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const keyHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("INSERT INTO clients (id, name, key_hash, created_at) VALUES (?, ?, ?, unixepoch())")
    .bind(id, name, keyHash)
    .run();
  return { id, key };
}

export async function insertTemplate(clientId: string, name: string, locale: Locale, t: Template): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO templates (client_id, name, locale, subject, html, text, variables, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())",
  )
    .bind(clientId, name, locale, t.subject, t.html, t.text, JSON.stringify(t.variables))
    .run();
}

export interface CallInit {
  key?: string;
  method?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export function call(path: string, init: CallInit = {}, send: SendMailFn = async () => {}, testEnv: Env = env): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.key) headers.Authorization = `Bearer ${init.key}`;
  const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return handle(new Request(`https://notify.test${path}`, { method: init.method ?? "GET", headers, body }), testEnv, send);
}

/** A SendMailFn that records every attempt and throws the queued failures in order (falsy = succeed). */
export function recorder(...failures: unknown[]): { send: SendMailFn; messages: MailMessage[] } {
  const messages: MailMessage[] = [];
  return {
    messages,
    send: async (_config, message) => {
      messages.push(message);
      const failure = failures.shift();
      if (failure) throw failure;
    },
  };
}

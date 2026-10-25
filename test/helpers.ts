import { env } from "cloudflare:workers";
import { handle } from "../src/index";
import { b64url, deriveKeys } from "../src/push/crypto";
import type { PushFetch } from "../src/push/routes";
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

function apiRequest(path: string, init: CallInit): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.key) headers.Authorization = `Bearer ${init.key}`;
  const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return new Request(`https://notify.test${path}`, { method: init.method ?? "GET", headers, body });
}

export function call(path: string, init: CallInit = {}, send: SendMailFn = async () => {}, testEnv: Env = env): Promise<Response> {
  return handle(apiRequest(path, init), testEnv, send);
}

/** The RFC 8291 sender key pair (the example's application server), as a test VAPID key pair. */
export const VAPID_TEST = {
  publicKey: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  privateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
};

/** `env` with Web Push configured. */
export const pushEnv = {
  ...env,
  VAPID_PUBLIC_KEY: VAPID_TEST.publicKey,
  VAPID_PRIVATE_KEY: VAPID_TEST.privateKey,
  VAPID_SUBJECT: "mailto:ops@example.com",
} as Env;

export async function enablePush(clientId: string, on = true): Promise<void> {
  await env.DB.prepare("UPDATE clients SET push_enabled = ? WHERE id = ?").bind(on ? 1 : 0, clientId).run();
}

/** A push service that accepts everything. */
const accept: PushFetch = async () => new Response(null, { status: 201 });

/** Like `call`, with Web Push configured and the push HTTP call injected. */
export function pushCall(path: string, init: CallInit = {}, fetchPush: PushFetch = accept, testEnv: Env = pushEnv): Promise<Response> {
  return handle(apiRequest(path, init), testEnv, async () => {}, undefined, fetchPush);
}

/**
 * A push service that records every request. `script` maps an endpoint to its next outcomes, consumed one per call:
 * a number answers with that status, an Error rejects; an empty script answers 201.
 */
export function pushRecorder(script: Record<string, Array<number | Error>> = {}): {
  fetch: PushFetch;
  requests: { url: string; headers: Headers; body: Uint8Array }[];
} {
  const requests: { url: string; headers: Headers; body: Uint8Array }[] = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, headers: new Headers(init.headers), body: init.body as Uint8Array });
      const outcome = script[url]?.shift() ?? 201;
      if (outcome instanceof Error) throw outcome;
      return new Response(null, { status: outcome });
    },
  };
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

/** A Queue that records sent bodies, or throws on send when `fail` is set. */
export function fakeQueue(fail = false): { queue: Queue; sent: any[] } {
  const sent: any[] = [];
  const send = async (body: unknown) => {
    if (fail) throw new Error("queue down");
    sent.push(body);
  };
  return { queue: { send } as unknown as Queue, sent };
}

export const SETUP_TOKEN = "test-setup-token";

export interface AdminInit {
  method?: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}

/** Calls /admin/api/<path>. A body means POST with Content-Type: application/json. */
export function adminCall(path: string, init: AdminInit = {}, testEnv: Env = env): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.cookie) headers.Cookie = init.cookie;
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return handle(new Request(`https://notify.test/admin/api/${path}`, { method, headers: { ...headers, ...init.headers }, body }), testEnv);
}

/** "nf_admin=<token>" from a response's Set-Cookie, ready for a Cookie header. */
export const sessionCookie = (res: Response): string => res.headers.get("Set-Cookie")!.split(";")[0];

/** D1 state is shared by the tests of a file: start every admin test with no account and no session. */
export async function resetAdmin(): Promise<void> {
  await env.DB.batch([env.DB.prepare("DELETE FROM admin_sessions"), env.DB.prepare("DELETE FROM admin_user")]);
}

/** Registers the admin (admin@example.com / "correct horse battery") and returns its session cookie. */
export async function setupAdmin(): Promise<string> {
  await resetAdmin();
  const res = await adminCall("setup", {
    body: { setup_token: SETUP_TOKEN, email: "admin@example.com", password: "correct horse battery" },
  });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status}`);
  return sessionCookie(res);
}

/** A browser's push subscription keys: an ECDH P-256 pair and a 16-byte auth secret, base64url-encoded. */
export async function browserKeys(): Promise<{ privateKey: CryptoKey; p256dh: string; auth: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    p256dh: b64url.encode(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)),
    auth: b64url.encode(crypto.getRandomValues(new Uint8Array(16))),
  };
}

/** What a browser does with an aes128gcm push body: derive the keys, decrypt, strip the 0x02 delimiter. */
export async function decryptPush(body: Uint8Array, browser: { privateKey: CryptoKey; auth: string }): Promise<string> {
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 86);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const algorithm = { name: "ECDH", public: asKey } as SubtleCryptoDeriveKeyAlgorithm; // the Workers types call it `$public`
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(algorithm, browser.privateKey, 256));
  // The pair is extractable, so the browser's own public point comes from the private JWK.
  const jwk = (await crypto.subtle.exportKey("jwk", browser.privateKey)) as JsonWebKey;
  const uaPublic = Uint8Array.of(4, ...b64url.decode(jwk.x!), ...b64url.decode(jwk.y!));
  const { cek, nonce } = await deriveKeys(ecdh, b64url.decode(browser.auth), uaPublic, asPublic, salt);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(86)));
  return new TextDecoder().decode(plain.slice(0, -1));
}

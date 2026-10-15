import { sha256Hex } from "../security/auth";
import { HttpError } from "../types";

// The most Workers' WebCrypto allows. Stored in each hash, so raising it later needs no migration.
const ITERATIONS = 100_000;
const SESSION_TTL_S = 7 * 24 * 3600;
const COOKIE_ATTRS = "HttpOnly; Secure; SameSite=Strict; Path=/admin";
const COOKIE_RE = /(?:^|;\s*)nf_admin=([0-9a-f]{64})(?:;|$)/;
const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (h) => parseInt(h, 16));

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

/** `pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${hex(salt)}$${hex(await pbkdf2(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, iterations, salt, hash] = stored.split("$");
  return crypto.subtle.timingSafeEqual(await pbkdf2(password, unhex(salt), Number(iterations)), unhex(hash));
}

/** Constant-time comparison. Both sides are hashed first, so their lengths always match. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}

/** Stores a new session (only its token's SHA-256) and returns the Set-Cookie value. */
export async function createSession(db: D1Database): Promise<string> {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare("INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, unixepoch() + ?)")
    .bind(await sha256Hex(token), SESSION_TTL_S)
    .run();
  return `nf_admin=${token}; ${COOKIE_ATTRS}; Max-Age=${SESSION_TTL_S}`;
}

export const CLEARED_COOKIE = `nf_admin=; ${COOKIE_ATTRS}; Max-Age=0`;
/** The stored hash of the request's session token, or null without a valid, unexpired session. */
export async function sessionHash(req: Request, db: D1Database): Promise<string | null> {
  const token = COOKIE_RE.exec(req.headers.get("Cookie") ?? "")?.[1];
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await db.prepare("SELECT 1 FROM admin_sessions WHERE token_hash = ? AND expires_at > unixepoch()").bind(hash).first();
  return row ? hash : null;
}

export async function requireSession(req: Request, db: D1Database): Promise<string> {
  const hash = await sessionHash(req, db);
  if (!hash) throw new HttpError(401, "unauthorized", "Login required");
  return hash;
}

export async function purgeSessions(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM admin_sessions WHERE expires_at <= unixepoch()").run();
}

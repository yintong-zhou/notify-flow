import { HttpError } from "../types";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Returns the client id for the request's API key (Bearer or X-API-Key), or throws 401. */
export async function authenticate(req: Request, env: Env): Promise<string> {
  const authorization = req.headers.get("Authorization");
  const key = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : req.headers.get("X-API-Key")?.trim();
  if (!key) throw new HttpError(401, "unauthorized", "Missing API key");
  const row = await env.DB.prepare("SELECT id FROM clients WHERE key_hash = ?")
    .bind(await sha256Hex(key))
    .first<{ id: string }>();
  if (!row) throw new HttpError(401, "unauthorized", "Invalid API key");
  return row.id;
}

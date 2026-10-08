import { env } from "cloudflare:workers";
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

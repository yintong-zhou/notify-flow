import { HttpError } from "../types";
import { listBuiltins } from "./defaults";

/** Built-in event → template mappings; each client can override them or add events in `event_routes`. */
export const BUILTIN_EVENTS: Readonly<Record<string, string>> = {
  "user.welcome": "welcome",
  "auth.email_verification": "verify-email",
  "auth.password_reset": "password-reset",
  "auth.password_changed": "password-changed",
  "auth.login_alert": "login-alert",
  "notification.generic": "generic-notification",
};

export async function findEventRoute(
  db: D1Database,
  clientId: string,
  event: string,
): Promise<{ template: string; builtin: boolean } | null> {
  const row = await db
    .prepare("SELECT template FROM event_routes WHERE client_id = ? AND event = ?")
    .bind(clientId, event)
    .first<{ template: string }>();
  if (row) return { template: row.template, builtin: false };
  // hasOwn, as in defaults.ts: findEventRoute is exported, so it must not rely on callers validating the name.
  const builtin = Object.hasOwn(BUILTIN_EVENTS, event) ? BUILTIN_EVENTS[event] : undefined;
  return builtin ? { template: builtin, builtin: true } : null;
}

export async function resolveEvent(db: D1Database, clientId: string, event: string): Promise<string> {
  const found = await findEventRoute(db, clientId, event);
  if (!found) throw new HttpError(404, "event_not_found", `Event "${event}" not found`);
  return found.template;
}

/** Whether `name` exists for this client in any locale, or as a built-in. */
export async function templateExists(db: D1Database, clientId: string, name: string): Promise<boolean> {
  if (listBuiltins().some((b) => b.name === name)) return true;
  const row = await db.prepare("SELECT 1 FROM templates WHERE client_id = ? AND name = ? LIMIT 1").bind(clientId, name).first();
  return row !== null;
}

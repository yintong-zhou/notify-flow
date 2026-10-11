# Notifications Plan — Part 2: Task 1 tests and code

[← Part 1](2026-10-11-notifications.md) · [Part 3 →](2026-10-11-notifications-part3.md)

## Task 1 tests

`test/notifications.test.ts` (new file). Task 2 adds imports and appends to it.

```ts
import { describe, expect, it } from "vitest";
import { call, createClient, insertTemplate } from "./helpers";

const custom = { subject: "Reset {{name}}", html: "<p>{{name}} {{link}}</p>", text: "{{name}} {{link}}", variables: ["name", "link"] };
const putEvent = (key: string, event: string, body: unknown) => call(`/v1/events/${event}`, { key, method: "PUT", body });

describe("/v1/events", () => {
  it("lists the built-in events for a new client", async () => {
    const { key } = await createClient();
    const res = await call("/v1/events", { key });
    expect(res.status).toBe(200);
    const list = await res.json<any[]>();
    expect(list).toHaveLength(6);
    expect(list).toContainEqual({ event: "auth.password_reset", template: "password-reset", builtin: true, updated_at: null });
  });

  it("overrides a built-in event and restores it on delete", async () => {
    const { id: clientId, key } = await createClient();
    await insertTemplate(clientId, "my-reset", "en", custom);
    const put = await putEvent(key, "auth.password_reset", { template: "my-reset" });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ event: "auth.password_reset", template: "my-reset", builtin: false });
    const list = await (await call("/v1/events", { key })).json<any[]>();
    expect(list).toHaveLength(6);
    expect(list.filter((e) => e.event === "auth.password_reset")).toEqual([
      { event: "auth.password_reset", template: "my-reset", builtin: false, updated_at: expect.any(Number) },
    ]);

    expect((await call("/v1/events/auth.password_reset", { key, method: "DELETE" })).status).toBe(204);
    const restored = await call("/v1/events/auth.password_reset", { key });
    expect(await restored.json()).toEqual({ event: "auth.password_reset", template: "password-reset", builtin: true });
  });

  it("adds a new event pointing to a built-in template", async () => {
    const { key } = await createClient();
    expect((await putEvent(key, "billing.invoice_ready", { template: "generic-notification" })).status).toBe(200);
    const res = await call("/v1/events/billing.invoice_ready", { key });
    expect(await res.json()).toEqual({ event: "billing.invoice_ready", template: "generic-notification", builtin: false });
  });

  it("rejects a mapping to a template that does not exist", async () => {
    const { key } = await createClient();
    const res = await putEvent(key, "billing.invoice_ready", { template: "no-such-template" });
    expect(res.status).toBe(404);
    expect((await res.json<any>()).error.code).toBe("template_not_found");
  });

  it("rejects invalid event and template names", async () => {
    const { key } = await createClient();
    for (const event of ["nodot", "Auth.Reset", "auth..reset", `a.${"b".repeat(63)}`]) {
      const res = await putEvent(key, event, { template: "welcome" });
      expect(res.status, event).toBe(400);
      expect((await res.json<any>()).error.code).toBe("validation_error");
    }
    expect((await putEvent(key, "billing.x", { template: "Bad Name" })).status).toBe(400);
  });

  it("keeps mappings separate for each client", async () => {
    const a = await createClient("a");
    const b = await createClient("b");
    expect((await putEvent(a.key, "billing.invoice_ready", { template: "welcome" })).status).toBe(200);
    expect((await call("/v1/events/billing.invoice_ready", { key: b.key })).status).toBe(404);
    expect((await call("/v1/events/billing.invoice_ready", { key: b.key, method: "DELETE" })).status).toBe(404);
  });

  it("answers 404 for unknown events and for deleting a built-in", async () => {
    const { key } = await createClient();
    const del = await call("/v1/events/auth.password_reset", { key, method: "DELETE" });
    expect(del.status).toBe(404);
    expect((await del.json<any>()).error.code).toBe("event_not_found");
    expect((await call("/v1/events/nobody.knows", { key })).status).toBe(404);
  });

  it("allows only GET on the list", async () => {
    const { key } = await createClient();
    expect((await call("/v1/events", { key, method: "POST", body: {} })).status).toBe(405);
  });
});
```

## Task 1 code

**`migrations/0005_event_routes.sql`**

```sql
-- Per-client event → template mappings, on top of the built-ins in src/templates/events.ts.
CREATE TABLE event_routes (
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  template   TEXT NOT NULL,      -- template name; the locale is chosen at send time
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, event)
);
```

**`src/templates/events.ts`** (new file)

```ts
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
  // Event names always contain a dot, so they can never match an Object.prototype key.
  const builtin = BUILTIN_EVENTS[event] as string | undefined;
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
```

**`src/security/validation.ts`**: add this after `parseTemplateKey`.

```ts
const EVENT_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

export function parseEvent(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 64 || !EVENT_RE.test(raw)) {
    invalid("event must be at most 64 characters matching ^[a-z0-9_]+(\\.[a-z0-9_]+)+$");
  }
  return raw;
}

export function parseEventRoute(body: Record<string, unknown>): { template: string } {
  const { template } = body;
  if (typeof template !== "string" || !NAME_RE.test(template)) invalid("template must match ^[a-z0-9-]{1,64}$");
  return { template };
}
```

**`src/routes/events.ts`** (new file): the code is at the top of [Part 3](2026-10-11-notifications-part3.md#task-1-code-continued).

**`src/index.ts`**:
- Import `{ deleteEvent, getEvent, listEvents, putEvent }` from `./routes/events`.
- Add `const EVENT_PATH = /^\/v1\/events\/([^/]+)$/;` next to `TEMPLATE_PATH`.
- Insert this before the `/v1/templates` block:

```ts
    if (pathname === "/v1/events") {
      allow(req, "GET");
      return await listEvents(env, clientId);
    }
    const eventMatch = EVENT_PATH.exec(pathname);
    if (eventMatch) {
      allow(req, "GET", "PUT", "DELETE");
      const event = eventMatch[1];
      if (req.method === "GET") return await getEvent(env, clientId, event);
      if (req.method === "PUT") return await putEvent(req, env, clientId, event);
      return await deleteEvent(env, clientId, event);
    }
```

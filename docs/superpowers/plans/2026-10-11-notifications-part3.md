# Notifications Plan — Part 3: Task 1 routes, Task 2 tests and code

[← Part 2](2026-10-11-notifications-part2.md) · [Part 4 →](2026-10-11-notifications-part4.md)

## Task 1 code (continued)

**`src/routes/events.ts`** (new file):

```ts
import { parseEvent, parseEventRoute, readJson } from "../security/validation";
import { BUILTIN_EVENTS, findEventRoute, templateExists } from "../templates/events";
import { HttpError } from "../types";

const eventNotFound = (event: string) => new HttpError(404, "event_not_found", `Event "${event}" not found`);

export async function listEvents(env: Env, clientId: string): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT event, template, updated_at FROM event_routes WHERE client_id = ? ORDER BY event")
    .bind(clientId)
    .all<{ event: string; template: string; updated_at: number }>();
  const own = new Set(results.map((r) => r.event));
  return Response.json([
    ...results.map((r) => ({ ...r, builtin: false })),
    ...Object.entries(BUILTIN_EVENTS)
      .filter(([event]) => !own.has(event))
      .map(([event, template]) => ({ event, template, builtin: true, updated_at: null })),
  ]);
}

export async function getEvent(env: Env, clientId: string, rawEvent: string): Promise<Response> {
  const event = parseEvent(rawEvent);
  const found = await findEventRoute(env.DB, clientId, event);
  if (!found) throw eventNotFound(event);
  return Response.json({ event, ...found });
}

export async function putEvent(req: Request, env: Env, clientId: string, rawEvent: string): Promise<Response> {
  const event = parseEvent(rawEvent);
  const { template } = parseEventRoute(await readJson(req));
  // Checked now, so a typo surfaces while configuring rather than on the first send.
  if (!(await templateExists(env.DB, clientId, template))) {
    throw new HttpError(404, "template_not_found", `Template "${template}" not found`);
  }
  await env.DB.prepare(
    `INSERT INTO event_routes (client_id, event, template, updated_at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT (client_id, event) DO UPDATE SET template = excluded.template, updated_at = excluded.updated_at`,
  )
    .bind(clientId, event, template)
    .run();
  return Response.json({ event, template, builtin: false });
}

export async function deleteEvent(env: Env, clientId: string, rawEvent: string): Promise<Response> {
  const event = parseEvent(rawEvent);
  const { meta } = await env.DB.prepare("DELETE FROM event_routes WHERE client_id = ? AND event = ?").bind(clientId, event).run();
  if (meta.changes === 0) throw eventNotFound(event);
  return new Response(null, { status: 204 });
}
```

## Task 2 tests

Change the imports of `test/notifications.test.ts` to:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, createClient, fakeQueue, insertTemplate, recorder } from "./helpers";
```

Append this:

```ts
const unique = (prefix: string) => `${prefix}-${crypto.randomUUID()}@example.com`;
const resetData = { appName: "Acme", name: "Jane", resetUrl: "https://app.test/reset?t=1" };
const reset = (email: string, extra: Record<string, unknown> = {}) => ({ event: "auth.password_reset", recipient: { email }, data: resetData, ...extra });
const notify = (key: string, body: unknown, send = recorder().send, headers: Record<string, string> = {}, testEnv: Env = env) =>
  call("/v1/notifications", { key, method: "POST", body, headers }, send, testEnv);
const sendDirect = (key: string, to: string, send = recorder().send, headers: Record<string, string> = {}) =>
  call("/v1/email/send", { key, method: "POST", headers, body: { template: "password-reset", to, variables: resetData } }, send);

describe("POST /v1/notifications", () => {
  it("sends the template mapped to a built-in event", async () => {
    const { key } = await createClient();
    const rec = recorder();
    const to = unique("reset");
    const res = await notify(key, reset(to), rec.send);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toEqual({ id: expect.stringMatching(/^msg_/), status: "submitted" });
    expect(rec.messages).toHaveLength(1);
    expect(rec.messages[0]).toMatchObject({ to, subject: "Reset your Acme password" });
    const row = await env.DB.prepare("SELECT template, recipient FROM email_deliveries WHERE id = ?").bind(body.id).first();
    expect(row).toEqual({ template: "password-reset", recipient: to });
  });

  it("uses recipient.locale", async () => {
    const { key } = await createClient();
    const rec = recorder();
    const body = { event: "auth.password_reset", recipient: { email: unique("it"), locale: "it" }, data: resetData };
    expect((await notify(key, body, rec.send)).status).toBe(200);
    expect(rec.messages[0].subject).toBe("Reimposta la password di Acme");
  });

  it("follows a client mapping, with the template's own locales", async () => {
    const { id: clientId, key } = await createClient();
    await insertTemplate(clientId, "my-reset", "it", custom);
    expect((await putEvent(key, "auth.password_reset", { template: "my-reset" })).status).toBe(200);
    const rec = recorder();
    const data = { name: "Jane", link: "https://x.test" };
    const ok = await notify(key, { event: "auth.password_reset", recipient: { email: unique("map"), locale: "it" }, data }, rec.send);
    expect(ok.status).toBe(200);
    expect(rec.messages[0].subject).toBe("Reset Jane");
    // "my-reset" exists only in "it": "en" has neither a client nor a built-in "my-reset".
    const missing = await notify(key, { event: "auth.password_reset", recipient: { email: unique("map-en") }, data });
    expect(missing.status).toBe(404);
    expect((await missing.json<any>()).error.code).toBe("template_not_found");
  });

  it("rejects unknown events and invalid payloads", async () => {
    const { key } = await createClient();
    const unknown = await notify(key, reset(unique("u"), { event: "nobody.knows" }));
    expect(unknown.status).toBe(404);
    expect((await unknown.json<any>()).error.code).toBe("event_not_found");
    const bad = [
      { event: "nodot" },
      { recipient: null },
      { recipient: [] },
      { recipient: "jane@example.com" },
      { recipient: {} },
      { recipient: { email: "a<b@example.com" } },
      { recipient: { email: unique("fr"), locale: "fr" } },
      { data: "nope" },
    ];
    for (const extra of bad) {
      const res = await notify(key, reset(unique("bad"), extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect((await res.json<any>()).error.code).toBe("validation_error");
    }
    const vars = await notify(key, reset(unique("vars"), { data: { appName: "Acme" } }));
    expect(vars.status).toBe(400);
    expect((await vars.json<any>()).error.code).toBe("invalid_variables");
  });

  it("enqueues the resolved template with Prefer: respond-async", async () => {
    const { id: clientId, key } = await createClient();
    const q = fakeQueue();
    const to = unique("async");
    const res = await notify(key, reset(to), recorder().send, { Prefer: "respond-async" }, { ...env, EMAIL_QUEUE: q.queue });
    expect(res.status).toBe(202);
    const { id } = await res.json<any>();
    expect(q.sent).toEqual([{ id, clientId, template: "password-reset", to, locale: "en", variables: resetData }]);
  });

  it("answers an Idempotency-Key replay, even across /v1/email/send, without sending again", async () => {
    const { key } = await createClient();
    const rec = recorder();
    const to = unique("idem");
    const headers = { "Idempotency-Key": "reset-1" };
    const first = await (await notify(key, reset(to), rec.send, headers)).json<any>();
    expect(await (await notify(key, reset(to), rec.send, headers)).json()).toEqual(first);
    expect(await (await sendDirect(key, to, rec.send, headers)).json()).toEqual(first);
    expect(rec.messages).toHaveLength(1);
  });

  it("shares the recipient limit with /v1/email/send for the same template", async () => {
    const { key } = await createClient();
    const to = unique("limit");
    for (let i = 0; i < 3; i++) expect((await sendDirect(key, to)).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await notify(key, reset(to))).status).toBe(200);
    expect((await notify(key, reset(to))).status).toBe(429);
  });

  it("allows only POST", async () => {
    const { key } = await createClient();
    expect((await call("/v1/notifications", { key })).status).toBe(405);
  });
});
```

The `custom` and `putEvent` helpers come from the Task 1 tests at the top of the file.

## Task 2 code

The code is in [Part 4, "Task 2 code"](2026-10-11-notifications-part4.md#task-2-code).

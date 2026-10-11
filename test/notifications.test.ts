import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, createClient, fakeQueue, insertTemplate, recorder } from "./helpers";

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

describe("Idempotency-Key validation order", () => {
  const badKey = { "Idempotency-Key": "k".repeat(256) };

  it("rejects a bad key on /v1/email/send before reading the body", async () => {
    const { key } = await createClient();
    const res = await call("/v1/email/send", { key, method: "POST", headers: badKey, rawBody: "a".repeat(256 * 1024 + 1) });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe("validation_error");
  });

  it("rejects a bad key on /v1/notifications before resolving the event", async () => {
    const { key } = await createClient();
    const res = await notify(key, reset(unique("key"), { event: "nobody.knows" }), recorder().send, badKey);
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe("validation_error");
  });
});

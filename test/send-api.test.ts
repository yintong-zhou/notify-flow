import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { SmtpError } from "../src/smtp/smtp-client";
import { call, createClient, insertTemplate, recorder } from "./helpers";

const welcome = (to: string, extra: Record<string, unknown> = {}) => ({
  template: "welcome",
  to,
  variables: { appName: "Acme", name: "Mario" },
  ...extra,
});
const send = (key: string, body: unknown, s = recorder().send, headers: Record<string, string> = {}) =>
  call("/v1/email/send", { key, method: "POST", body, headers }, s);
const row = (id: string) => env.DB.prepare("SELECT * FROM email_deliveries WHERE id = ?").bind(id).first<any>();
const rowCount = async (clientId: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM email_deliveries WHERE client_id = ?").bind(clientId).first<{ n: number }>())!.n;

describe("POST /v1/email/send", () => {
  it("renders, sends and logs a submitted delivery", async () => {
    const { id: clientId, key } = await createClient();
    const rec = recorder();
    const res = await send(key, welcome("Mario.Rossi@Example.COM"), rec.send);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toEqual({ id: expect.stringMatching(/^msg_/), status: "submitted" });

    expect(rec.messages).toHaveLength(1);
    expect(rec.messages[0]).toMatchObject({
      to: "mario.rossi@example.com",
      from: "noreply@example.com",
      fromName: "Notify Flow",
      subject: "Welcome to Acme",
      messageId: `${body.id}@example.com`,
    });

    expect(await row(body.id)).toMatchObject({
      client_id: clientId,
      template: "welcome",
      provider: "gmail",
      recipient: "mario.rossi@example.com",
      status: "submitted",
      attempts: 1,
      error_code: null,
    });
    expect((await row(body.id)).sent_at).toBeTypeOf("number");
  });

  it("uses the requested locale and the client's own template", async () => {
    const { id: clientId, key } = await createClient();
    const it1 = recorder();
    await send(key, welcome(`a-${crypto.randomUUID()}@example.com`, { locale: "it" }), it1.send);
    expect(it1.messages[0].subject).toBe("Benvenuto su Acme");

    await insertTemplate(clientId, "welcome", "en", { subject: "Yo {{name}}", html: "<p>{{name}}</p>", text: "{{name}}", variables: ["name"] });
    const own = recorder();
    await send(key, { template: "welcome", to: `b-${crypto.randomUUID()}@example.com`, variables: { name: "Mario" } }, own.send);
    expect(own.messages[0].subject).toBe("Yo Mario");
  });

  it.each([
    ["two recipients", { to: "a@example.com, b@example.com" }],
    ["CR/LF in to", { to: "a@example.com\r\nBcc: x@example.com" }],
    ["unsupported locale", { locale: "fr" }],
    ["non-string variable", { variables: { appName: "Acme", name: 42 } }],
    ["bad template name", { template: "Bad_Name" }],
  ] as [string, Record<string, unknown>][])("rejects %s with 400 and sends nothing", async (_label, override) => {
    const { id: clientId, key } = await createClient();
    const rec = recorder();
    const res = await send(key, { ...welcome("a@example.com"), ...override }, rec.send);
    expect(res.status).toBe(400);
    expect(rec.messages).toHaveLength(0);
    expect(await rowCount(clientId)).toBe(0);
  });

  it("rejects variables that do not match the template", async () => {
    const { key } = await createClient();
    const res = await send(key, { template: "welcome", to: "a@example.com", variables: { name: "Mario" } });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe("invalid_variables");
  });

  it("returns 404 for an unknown template", async () => {
    const { key } = await createClient();
    const res = await send(key, { template: "nope", to: "a@example.com", variables: {} });
    expect(res.status).toBe(404);
    expect((await res.json<any>()).error.code).toBe("template_not_found");
  });

  it("does not send twice for the same Idempotency-Key", async () => {
    const { key } = await createClient();
    const rec = recorder();
    const to = `idem-${crypto.randomUUID()}@example.com`;
    const first = await (await send(key, welcome(to), rec.send, { "Idempotency-Key": "reset:1" })).json<any>();
    const second = await (await send(key, welcome(to), rec.send, { "Idempotency-Key": "reset:1" })).json<any>();
    expect(second).toEqual(first);
    expect(rec.messages).toHaveLength(1);
  });

  it("limits sends per recipient and template, but still answers idempotent replays", async () => {
    const { key } = await createClient();
    const rec = recorder();
    const to = `limit-${crypto.randomUUID()}@example.com`;
    const first = await (await send(key, welcome(to), rec.send, { "Idempotency-Key": "first" })).json<any>();
    for (let i = 0; i < 4; i++) expect((await send(key, welcome(to), rec.send)).status).toBe(200);

    const blocked = await send(key, welcome(to), rec.send);
    expect(blocked.status).toBe(429);
    expect((await blocked.json<any>()).error.code).toBe("rate_limited");

    const replay = await send(key, welcome(to), rec.send, { "Idempotency-Key": "first" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(first);
    expect(rec.messages).toHaveLength(5);
  });

  it("keeps the recipient limit separate for each client", async () => {
    const a = await createClient("a");
    const b = await createClient("b");
    const to = `shared-${crypto.randomUUID()}@example.com`;
    for (let i = 0; i < 5; i++) expect((await send(a.key, welcome(to))).status).toBe(200);
    expect((await send(a.key, welcome(to))).status).toBe(429);
    expect((await send(b.key, welcome(to))).status).toBe(200);
  });

  it("does not count failed sends against the recipient limit", async () => {
    const { key } = await createClient();
    const to = `outage-${crypto.randomUUID()}@example.com`;
    for (let i = 0; i < 5; i++) {
      const rec = recorder(new SmtpError("smtp_rejected", false, "SMTP 554"));
      expect((await send(key, welcome(to), rec.send)).status).toBe(502);
    }
    expect((await send(key, welcome(to))).status).toBe(200);
  });

  it("keeps the send alive with ctx.waitUntil", async () => {
    const { key } = await createClient();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    const req = new Request("https://notify.test/v1/email/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify(welcome(`w-${crypto.randomUUID()}@example.com`)),
    });
    expect((await handle(req, env, recorder().send, ctx)).status).toBe(200);
    expect(pending).toHaveLength(1);
  });

  it("reports an abandoned processing row as failed on replay", async () => {
    const { id: clientId, key } = await createClient();
    const to = `stale-${crypto.randomUUID()}@example.com`;
    await env.DB.prepare(
      `INSERT INTO email_deliveries (id, request_id, client_id, idempotency_key, template, provider, recipient, status, created_at)
       VALUES ('msg_stale', 'r', ?, 'stale-key', 'welcome', 'gmail', ?, 'processing', unixepoch() - 600)`,
    )
      .bind(clientId, to)
      .run();
    const rec = recorder();
    const replay = await send(key, welcome(to), rec.send, { "Idempotency-Key": "stale-key" });
    expect(await replay.json()).toEqual({ id: "msg_stale", status: "failed" });
    expect(await row("msg_stale")).toMatchObject({ status: "failed", error_code: "abandoned" });
    expect(rec.messages).toHaveLength(0);
  });

  it("retries a transient SMTP failure", async () => {
    const { key } = await createClient();
    const rec = recorder(new SmtpError("smtp_temporary_failure", true, "SMTP 451"));
    const body = await (await send(key, welcome(`t-${crypto.randomUUID()}@example.com`), rec.send)).json<any>();
    expect(body.status).toBe("submitted");
    expect(rec.messages).toHaveLength(2);
    expect((await row(body.id)).attempts).toBe(2);
  });

  it("gives up after 3 transient failures", async () => {
    const { key } = await createClient();
    const transient = () => new SmtpError("smtp_timeout", true, "SMTP command timed out");
    const rec = recorder(transient(), transient(), transient());
    const res = await send(key, welcome(`g-${crypto.randomUUID()}@example.com`), rec.send);
    expect(res.status).toBe(502);
    const body = await res.json<any>();
    expect(await row(body.id)).toMatchObject({ status: "failed", attempts: 3, error_code: "smtp_timeout" });
  });

  it("does not retry a permanent failure and keeps the idempotent result", async () => {
    const { key } = await createClient();
    const rec = recorder(new SmtpError("smtp_rejected", false, "SMTP 550"));
    const to = `p-${crypto.randomUUID()}@example.com`;
    const res = await send(key, welcome(to), rec.send, { "Idempotency-Key": "k-fail" });
    expect(res.status).toBe(502);
    const body = await res.json<any>();
    expect(body).toEqual({ error: { code: "smtp_failed", message: expect.any(String) }, id: expect.stringMatching(/^msg_/) });
    expect(await row(body.id)).toMatchObject({ status: "failed", attempts: 1, error_code: "smtp_rejected" });

    const replay = await send(key, welcome(to), rec.send, { "Idempotency-Key": "k-fail" });
    expect(await replay.json()).toEqual({ id: body.id, status: "failed" });
    expect(rec.messages).toHaveLength(1);
  });

  it("marks the row failed when an unexpected error happens mid-send", async () => {
    const { id: clientId, key } = await createClient();
    const rec = recorder(new TypeError("boom"));
    const res = await send(key, welcome(`u-${crypto.randomUUID()}@example.com`), rec.send);
    expect(res.status).toBe(500);
    const rowAfter = await env.DB.prepare("SELECT status, error_code FROM email_deliveries WHERE client_id = ?")
      .bind(clientId)
      .first<any>();
    expect(rowAfter).toEqual({ status: "failed", error_code: "internal_error" });
  });

  it("returns 500 smtp_misconfigured without logging a delivery", async () => {
    const { id: clientId, key } = await createClient();
    const rec = recorder();
    const res = await call(
      "/v1/email/send",
      { key, method: "POST", body: welcome("a@example.com") },
      rec.send,
      { ...env, SMTP_PROVIDER: "generic" },
    );
    expect(res.status).toBe(500);
    expect((await res.json<any>()).error.code).toBe("smtp_misconfigured");
    expect(rec.messages).toHaveLength(0);
    expect(await rowCount(clientId)).toBe(0);
  });

  it("rejects an over-long Idempotency-Key", async () => {
    const { key } = await createClient();
    const res = await send(key, welcome("a@example.com"), recorder().send, { "Idempotency-Key": "k".repeat(256) });
    expect(res.status).toBe(400);
  });
});

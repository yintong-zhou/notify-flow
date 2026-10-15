import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { log, purgeLogs } from "../src/services/logger";
import { SmtpError, type SendMailFn } from "../src/smtp/smtp-client";
import { call, createClient, recorder } from "./helpers";

const rows = async () => (await env.DB.prepare("SELECT * FROM app_logs ORDER BY id").all<any>()).results;
const get = (path: string, headers: Record<string, string> = {}, testEnv: Env = env) =>
  handle(new Request(`https://notify.test${path}`, { headers }), testEnv);
const welcome = () => ({ template: "welcome", to: `log-${crypto.randomUUID()}@example.com`, variables: { appName: "Acme", name: "Mario" } });
const sendWith = (key: string, send: SendMailFn, headers: Record<string, string> = {}) =>
  call("/v1/email/send", { key, method: "POST", body: welcome(), headers }, send);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM app_logs").run();
});

describe("log()", () => {
  it("writes one row and cuts the path to 128 characters", async () => {
    await log(env.DB, { level: "info", code: "x", path: `/v1/${"a".repeat(200)}`, ip: "203.0.113.1" });
    const [row] = await rows();
    expect(row).toMatchObject({ level: "info", code: "x", ip: "203.0.113.1", status: null, detail: null });
    expect(row.path).toHaveLength(128);
    expect(row.created_at).toBeGreaterThan(0);
  });

  it("never throws when D1 fails", async () => {
    const broken = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    await expect(log(broken, { level: "error", code: "x" })).resolves.toBeUndefined();
  });
});

describe("request errors", () => {
  it("logs the level by status, with method, path and IP, never the query string", async () => {
    expect((await get("/v1/templates?token=secret", { "X-API-Key": "nf_wrong", "CF-Connecting-IP": "203.0.113.2" })).status).toBe(401);
    const { id: clientId, key } = await createClient();
    expect((await call("/v1/templates/BAD/en", { key })).status).toBe(400);
    expect((await call("/v1/nope", { key })).status).toBe(404);
    const [unauthorized, invalid, missing] = await rows();
    expect(unauthorized).toMatchObject({ level: "warn", code: "unauthorized", status: 401, method: "GET", path: "/v1/templates", ip: "203.0.113.2", client_id: null });
    expect(invalid).toMatchObject({ level: "info", code: "validation_error", status: 400, client_id: clientId });
    expect(missing).toMatchObject({ level: "info", code: "not_found", status: 404 });
    expect(JSON.stringify(await rows())).not.toContain("secret");
  });

  it("does not log 404s outside /v1 and /admin/api", async () => {
    expect((await get("/wp-login.php")).status).toBe(404);
    expect(await rows()).toEqual([]);
  });

  it("logs a failed sync send as an error with its message id, without the SMTP text", async () => {
    const { id: clientId, key } = await createClient();
    const res = await sendWith(key, recorder(new SmtpError("smtp_rejected", false, "SMTP 550 bob@example.com unknown")).send);
    expect(res.status).toBe(502);
    const { id } = await res.json<any>();
    expect(await rows()).toEqual([expect.objectContaining({ level: "error", code: "smtp_failed", status: 502, client_id: clientId, message_id: id })]);
    expect(JSON.stringify(await rows())).not.toContain("bob@example.com");
  });

  it("caps request warn/info rows at 30 per minute per IP, but never errors", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 31; i++) await get("/v1/templates", { "X-API-Key": "nf_wrong", "CF-Connecting-IP": ip });
    expect(await rows()).toHaveLength(30);
    const { key } = await createClient();
    await sendWith(key, recorder(new SmtpError("smtp_rejected", false, "x")).send, { "CF-Connecting-IP": ip });
    expect((await rows()).at(-1)).toMatchObject({ level: "error", code: "smtp_failed", ip });
  });

  it("answers normally when the log limiter fails", async () => {
    const broken = { ...env, LOG_RATE_LIMITER: { limit: async () => { throw new Error("down"); } } } as Env;
    const res = await get("/v1/templates", { "X-API-Key": "nf_wrong", "CF-Connecting-IP": "203.0.113.60" }, broken);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Invalid API key" } });
  });
});

describe("purgeLogs", () => {
  it("deletes rows older than 30 days and keeps newer ones", async () => {
    await env.DB.prepare(
      "INSERT INTO app_logs (created_at, level, code) VALUES (unixepoch() - 31 * 86400, 'info', 'old'), (unixepoch() - 29 * 86400, 'info', 'new')",
    ).run();
    await purgeLogs(env.DB);
    expect((await rows()).map((r) => r.code)).toEqual(["new"]);
  });
});

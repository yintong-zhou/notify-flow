# Admin Log Viewer Plan — Part 2: tests, Task 2 and Task 3

[← Part 1](2026-10-15-admin-logs.md) · [Part 3: UI and docs →](2026-10-15-admin-logs-part3.md)

## `test/logs.test.ts` (Task 1)

```ts
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
```

---

### Task 2: Log failed SMTP attempts

**Interfaces:** consumes `log` from Task 1. Produces nothing new.

- [ ] **Step 1: Failing tests.**
  - Append to `test/logs.test.ts`:

```ts
describe("SMTP attempts", () => {
  it("logs each transient failure before a retry, without the SMTP message", async () => {
    const { key } = await createClient();
    const transient = () => new SmtpError("smtp_timeout", true, "no reply from mx for bob@example.com");
    const { id, status } = await (await sendWith(key, recorder(transient(), transient()).send)).json<any>();
    expect(status).toBe("submitted");
    expect((await rows()).map((r) => [r.level, r.code, r.message_id, r.detail])).toEqual([
      ["warn", "smtp_attempt_failed", id, "smtp_timeout attempt 1/3"],
      ["warn", "smtp_attempt_failed", id, "smtp_timeout attempt 2/3"],
    ]);
    expect(JSON.stringify(await rows())).not.toContain("bob@example.com");
  });
});
```

  - In `test/async-send.test.ts`, inside `describe("handleQueue")`, add:

```ts
  it("logs a transient failure as smtp_attempt_failed and a final one as an error", async () => {
    const body = await queued();
    await consume(recorder(transient()).send, [message(body).msg]);
    await consume(recorder(new SmtpError("smtp_rejected", false, "SMTP 550 for bob@example.com")).send, [message(body).msg]);
    const logged = (await env.DB.prepare("SELECT level, code, client_id, detail FROM app_logs WHERE message_id = ? ORDER BY id").bind(body.id).all()).results;
    expect(logged).toEqual([
      { level: "warn", code: "smtp_attempt_failed", client_id: body.clientId, detail: "smtp_timeout attempt 1/5" },
      { level: "error", code: "smtp_rejected", client_id: body.clientId, detail: "attempt 2/5" },
    ]);
    expect(JSON.stringify(logged)).not.toContain("bob@example.com");
  });
```

  - Run `npx vitest run test/logs.test.ts test/async-send.test.ts`. Expected: these two tests FAIL (no rows, or no warn rows).
- [ ] **Step 2: `src/services/email-service.ts`.**
  - Add `import { log } from "./logger";`.
  - In `sendTemplatedEmail`'s retry branch, before `await sleep(...)`, add `await log(env.DB, { level: "warn", code: "smtp_attempt_failed", client_id: clientId, message_id: id, detail: \`${smtp.code} attempt ${attempt}/${MAX_ATTEMPTS}\` });`.
  - Delete the `console.error(...)` line after the `failed` UPDATE: the 502 reaches `errorResponse` with `id`.
  - Delete the `console.error(...)` line in `enqueueTemplatedEmail`'s `catch`: the 503 reaches `errorResponse` with `id`. Keep its comment.
- [ ] **Step 3: `src/services/queue-consumer.ts`.**
  - Add `import { log } from "./logger";`.
  - In the transient branch, as the branch's first line, add `await log(env.DB, { level: "warn", code: "smtp_attempt_failed", client_id: job.clientId, message_id: job.id, detail: \`${smtp.code} attempt ${attempts}/${MAX_ATTEMPTS}\` });`.
  - Replace `console.error(JSON.stringify({ id: job.id, client_id: job.clientId, error_code: errorCode }));` with `await log(env.DB, { level: "error", code: errorCode, client_id: job.clientId, message_id: job.id, detail: \`attempt ${attempts}/${MAX_ATTEMPTS}\` });`.
- [ ] **Step 4: Run.** Run `npx vitest run test/logs.test.ts test/async-send.test.ts`, then `npm test` and `npm run typecheck`. Expected: all pass, including the "D1 failing after the claim" tests (Review Focus 5).
- [ ] **Step 5: Commit.** Run `git add src test`, then `git commit -m "feat(logs): log failed SMTP attempts and final queue failures"`.

---

### Task 3: Logs API

**Interfaces:**
- **Consumes:** `withSession` from `src/admin/routes.ts`; `invalid`; `PAGE` (50) in `src/admin/stats.ts`.
- **Produces:** `logs(req, env)`, which returns `{logs: Row[], next: number | null}`. Task 4 consumes it.

- [ ] **Step 1: Failing tests.** Create `test/admin-logs.test.ts` from [Part 3](2026-10-15-admin-logs-part3.md#testadmin-logstestts). Run it. Expected: FAIL (404).
- [ ] **Step 2: Implement.** Append the `logs` handler from Part 3 to `src/admin/stats.ts`. In `routes.ts`:
  - import `logs` together with `stats` and `deliveries`;
  - add `logs: { GET: withSession(logs) },` to `ROUTES`.
- [ ] **Step 3: Run.** Run `npx vitest run test/admin-logs.test.ts`, then `npm test` and `npm run typecheck`. Expected: all pass.
- [ ] **Step 4: Commit.** Run `git add src test`, then `git commit -m "feat(logs): admin logs API"`.

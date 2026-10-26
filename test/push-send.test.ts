import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { purgePushDeliveries } from "../src/push/sender";
import { browserKeys, createClient, decryptPush, enablePush, pushCall, pushEnv, pushRecorder, VAPID_TEST } from "./helpers";

const E1 = "https://fcm.googleapis.com/fcm/send/1";
const E2 = "https://updates.push.services.mozilla.com/wpush/v2/2";
const BODY = {
  user_id: "u1",
  template: "new-message",
  locale: "it",
  variables: { appName: "Piattaforma XX", sender: "Marco" },
  url: "/chat/42",
  tag: "chat-42",
};

type Browser = Awaited<ReturnType<typeof browserKeys>>;
let key: string;
let id: string;
let browsers: Browser[];

async function register(endpoint: string, userId = "u1"): Promise<Browser> {
  const b = await browserKeys();
  const res = await pushCall("/v1/push/subscriptions", {
    key,
    method: "PUT",
    body: { user_id: userId, subscription: { endpoint, keys: { p256dh: b.p256dh, auth: b.auth } } },
  });
  expect(res.status).toBe(204);
  return b;
}

const send = (body: unknown, rec = pushRecorder(), headers?: Record<string, string>, testEnv = pushEnv) =>
  pushCall("/v1/push/send", { key, method: "POST", body, headers }, rec.fetch, testEnv);
const code = async (res: Response) => (await res.json<any>()).error.code;
const deliveries = async () =>
  (await env.DB.prepare("SELECT * FROM push_deliveries WHERE client_id = ? ORDER BY created_at, rowid").bind(id).all<any>()).results;
const logs = async (messageId: string) =>
  (await env.DB.prepare("SELECT code, level, detail FROM app_logs WHERE message_id = ? ORDER BY rowid").bind(messageId).all<any>()).results;
const endpoints = async () =>
  (await env.DB.prepare("SELECT endpoint FROM push_subscriptions WHERE client_id = ?").bind(id).all<any>()).results.map((r) => r.endpoint);
const payloadOf = async (rec: ReturnType<typeof pushRecorder>) => JSON.parse(await decryptPush(rec.requests[0].body, browsers[0]));

beforeEach(async () => {
  ({ id, key } = await createClient());
  await enablePush(id);
  browsers = [await register(E1)];
});

describe("POST /v1/push/send", () => {
  it("sends the base template to every device of the user", async () => {
    browsers.push(await register(E2));
    const rec = pushRecorder();
    const res = await send(BODY, rec);
    expect(res.status).toBe(200);
    const result = await res.json<any>();
    expect(result).toEqual({ id: expect.stringMatching(/^psh_/), status: "submitted", devices: 2 });
    expect(rec.requests).toHaveLength(2);
    for (const request of rec.requests) {
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("TTL")).toBe("86400");
      expect(request.headers.get("Urgency")).toBe("high");
      expect(request.headers.get("Topic")).toBe("chat-42");
      expect(request.headers.get("Content-Encoding")).toBe("aes128gcm");
      expect(request.headers.get("Authorization")).toMatch(new RegExp(`^vapid t=[^,]+, k=${VAPID_TEST.publicKey}$`));
      const browser = browsers[request.url === E1 ? 0 : 1];
      expect(JSON.parse(await decryptPush(request.body, browser))).toEqual({
        title: "Piattaforma XX",
        body: "Hai ricevuto una notifica da Marco",
        url: "/chat/42",
        tag: "chat-42",
      });
    }
    const [row] = await deliveries();
    expect(row).toMatchObject({ id: result.id, status: "submitted", devices: 2, tag: "chat-42" });
    expect(row.sent_at).not.toBeNull();
  });

  it("falls back to en and omits url, tag and Topic when not given", async () => {
    const rec = pushRecorder();
    const bare = { user_id: "u1", template: "new-message", variables: BODY.variables };
    expect((await send(bare, rec)).status).toBe(200);
    expect(rec.requests[0].headers.has("Topic")).toBe(false);
    expect(await payloadOf(rec)).toEqual({ title: "Piattaforma XX", body: "You received a notification from Marco" });

    const pt = pushRecorder();
    await send({ ...bare, locale: "pt-BR" }, pt);
    expect((await payloadOf(pt)).body).toBe("Você recebeu uma notificação de Marco");
  });

  it("keeps non-ASCII values intact", async () => {
    const rec = pushRecorder();
    await send({ ...BODY, variables: { appName: "Piattaforma XX", sender: "Zoë 🙂" } }, rec);
    expect((await payloadOf(rec)).body).toBe("Hai ricevuto una notifica da Zoë 🙂");
  });

  it("validates the request", async () => {
    const vars = (v: unknown) => ({ ...BODY, variables: { appName: "X", sender: v } });
    const bad: unknown[] = [
      { ...BODY, template: "New" },
      { ...BODY, locale: "fr" },
      { ...BODY, user_id: "" },
      { ...BODY, variables: null },
      vars(5),
      vars(""),
      vars("a".repeat(65)),
      vars("a\nb"),
      ...["//evil.com", "https://evil.com", "/a\\b", 5, "/" + "a".repeat(512)].map((url) => ({ ...BODY, url })),
      ...["has space", "a".repeat(33)].map((tag) => ({ ...BODY, tag })),
    ];
    for (const body of bad) {
      const res = await send(body);
      expect([res.status, await code(res)], JSON.stringify(body)).toEqual([400, "validation_error"]);
    }
    const missing = await send({ ...BODY, variables: { appName: "X" } });
    expect([missing.status, await code(missing)]).toEqual([400, "invalid_variables"]);
    const email = await send({ ...BODY, template: "welcome" });
    expect([email.status, await code(email)]).toEqual([404, "template_not_found"]);
  });

  it("answers 404 no_subscriptions without writing a row", async () => {
    const res = await send({ ...BODY, user_id: "nobody" });
    expect([res.status, await code(res)]).toEqual([404, "no_subscriptions"]);
    expect(await deliveries()).toHaveLength(0);
  });

  it("replays an Idempotency-Key without sending again", async () => {
    const rec = pushRecorder();
    const first = await send(BODY, rec, { "Idempotency-Key": "k1" });
    const second = await send(BODY, rec, { "Idempotency-Key": "k1" });
    expect(await second.json()).toEqual(await first.json());
    expect(rec.requests).toHaveLength(1);
  });

  it("closes an abandoned processing row on replay, but not a recent one", async () => {
    const insert = (rowId: string, k: string, age: number) =>
      env.DB.prepare(
        "INSERT INTO push_deliveries (id, request_id, client_id, idempotency_key, template, user_id, status, created_at) VALUES (?, 'r', ?, ?, 'new-message', 'u1', 'processing', unixepoch() - ?)",
      )
        .bind(rowId, id, k, age)
        .run();
    await insert("psh_replay_stuck", "k-stuck", 301);
    await insert("psh_replay_live", "k-live", 0);
    const rec = pushRecorder();
    expect(await (await send(BODY, rec, { "Idempotency-Key": "k-stuck" })).json()).toEqual({ id: "psh_replay_stuck", status: "failed", devices: 0 });
    expect(await (await send(BODY, rec, { "Idempotency-Key": "k-live" })).json()).toEqual({ id: "psh_replay_live", status: "processing", devices: 0 });
    expect(rec.requests).toHaveLength(0);
    expect((await deliveries()).map((r) => [r.id, r.status, r.error_code])).toEqual([
      ["psh_replay_stuck", "failed", "abandoned"],
      ["psh_replay_live", "processing", null],
    ]);
  });

  it("limits pushes per user and conversation per hour", async () => {
    const limited = { ...pushEnv, PUSH_LIMIT_PER_HOUR: "2" } as Env;
    const sendTag = (tag: string | undefined, rec = pushRecorder()) => {
      const { tag: _, ...untagged } = BODY;
      return send(tag ? { ...untagged, tag } : untagged, rec, undefined, limited);
    };
    expect((await sendTag("a")).status).toBe(200);
    expect((await sendTag("a")).status).toBe(200);
    const over = await sendTag("a");
    expect([over.status, await code(over)]).toEqual([429, "rate_limited"]);
    expect((await sendTag("b")).status).toBe(200);
    expect((await sendTag(undefined)).status).toBe(200);

    const failing = pushRecorder({ [E1]: [400, 400] });
    expect((await sendTag("c", failing)).status).toBe(502);
    expect((await sendTag("c", failing)).status).toBe(502);
    expect((await sendTag("c")).status).toBe(200);
  });

  it("removes subscriptions the push service reports gone", async () => {
    await register(E2);
    const res = await send(BODY, pushRecorder({ [E1]: [410] }));
    expect(res.status).toBe(200);
    expect((await res.json<any>()).devices).toBe(1);
    expect(await endpoints()).toEqual([E2]);
  });

  it("retries transient failures", async () => {
    const rec = pushRecorder({ [E1]: [503, 429] });
    const res = await send(BODY, rec);
    expect(res.status).toBe(200);
    expect(rec.requests).toHaveLength(3);
    const { id: messageId } = await res.json<any>();
    expect(await logs(messageId)).toEqual([
      { code: "push_attempt_failed", level: "warn", detail: "HTTP 503 attempt 1/3" },
      { code: "push_attempt_failed", level: "warn", detail: "HTTP 429 attempt 2/3" },
    ]);
  });

  it("gives up after three timeouts", async () => {
    const t = new DOMException("timeout", "TimeoutError");
    const res = await send(BODY, pushRecorder({ [E1]: [t, t, t] }));
    const body = await res.json<any>();
    expect([res.status, body.error.code, body.id]).toEqual([502, "push_failed", expect.stringMatching(/^psh_/)]);
    const [row] = await deliveries();
    expect(row).toMatchObject({ id: body.id, status: "failed", error_code: "push_failed" });
    expect((await logs(body.id)).filter((l) => l.code === "push_attempt_failed").map((l) => l.detail)).toEqual(["network attempt 1/3", "network attempt 2/3", "network attempt 3/3"]);
  });

  it("answers 404 push_expired when every device is gone", async () => {
    await register(E2);
    const res = await send(BODY, pushRecorder({ [E1]: [404], [E2]: [410] }));
    const body = await res.json<any>();
    expect([res.status, body.error.code, body.id]).toEqual([404, "no_subscriptions", expect.stringMatching(/^psh_/)]);
    expect((await deliveries())[0]).toMatchObject({ id: body.id, status: "failed", error_code: "push_expired" });
    expect(await endpoints()).toEqual([]);
  });

  it("answers 502 when every device rejects", async () => {
    const res = await send(BODY, pushRecorder({ [E1]: [403] }));
    const body = await res.json<any>();
    expect([res.status, body.error.code]).toEqual([502, "push_failed"]);
    expect((await deliveries())[0]).toMatchObject({ id: body.id, status: "failed", error_code: "push_failed" });
    expect(await endpoints()).toEqual([E1]);
  });

  it("treats a redirect as a permanent failure: one attempt, subscription kept", async () => {
    const rec = pushRecorder({ [E1]: [307] });
    const res = await send(BODY, rec);
    expect([res.status, await code(res)]).toEqual([502, "push_failed"]);
    expect(rec.requests).toHaveLength(1);
    expect(await endpoints()).toEqual([E1]);
  });

  it("does not retry or call the push service when signing fails", async () => {
    const rec = pushRecorder();
    const res = await send(BODY, rec, undefined, { ...pushEnv, VAPID_PRIVATE_KEY: "not-a-key" } as Env);
    const body = await res.json<any>();
    expect([res.status, body.error.code]).toEqual([502, "push_failed"]);
    expect(rec.requests).toHaveLength(0);
    expect((await logs(body.id)).filter((l) => l.code !== "push_failed")).toEqual([{ code: "push_device_error", level: "error", detail: null }]);
  });

  it("never stores or logs content", async () => {
    const vars = { appName: "Piattaforma XX", sender: "Marco-SECRET" };
    await send({ ...BODY, variables: vars, url: "/chat/SECRET-URL" }, pushRecorder({ [E1]: [503] }));
    const all = [
      ...(await env.DB.prepare("SELECT * FROM push_deliveries").all()).results,
      ...(await env.DB.prepare("SELECT * FROM app_logs").all()).results,
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) expect(JSON.stringify(row)).not.toMatch(/SECRET|fcm\.googleapis/);
  });

  it("purges old deliveries and closes abandoned ones", async () => {
    const insert = (rowId: string, status: string, age: number) =>
      env.DB.prepare(
        "INSERT INTO push_deliveries (id, request_id, client_id, template, user_id, status, created_at) VALUES (?, 'r', ?, 'new-message', 'u1', ?, unixepoch() - ?)",
      )
        .bind(rowId, id, status, age)
        .run();
    await insert("psh_old", "submitted", 31 * 86400);
    await insert("psh_stuck", "processing", 301);
    await insert("psh_live", "processing", 0);
    await purgePushDeliveries(env.DB);
    const rows = await deliveries();
    expect(rows.map((r) => [r.id, r.status, r.error_code])).toEqual([
      ["psh_stuck", "failed", "abandoned"],
      ["psh_live", "processing", null],
    ]);
  });
});

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { b64url } from "../src/push/crypto";
import { call, createClient, enablePush, pushCall, pushEnv, VAPID_TEST } from "./helpers";

// RFC 8291 section 5 browser keys, verbatim.
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

const sub = (endpoint: string, keys: Record<string, unknown> = {}) => ({ endpoint, keys: { p256dh: UA_PUBLIC, auth: AUTH, ...keys } });
const put = (key: string, body: unknown) => pushCall("/v1/push/subscriptions", { key, method: "PUT", body });
const del = (key: string, body: unknown, testEnv = pushEnv) => pushCall("/v1/push/subscriptions", { key, method: "DELETE", body }, undefined, testEnv);
const code = async (res: Response) => (await res.json<any>()).error.code;
const rows = async (clientId: string) =>
  (await env.DB.prepare("SELECT endpoint, user_id FROM push_subscriptions WHERE client_id = ? ORDER BY endpoint").bind(clientId).all<{ endpoint: string; user_id: string }>())
    .results;

const E = "https://fcm.googleapis.com/fcm/send/e";
const deny = { limit: async () => ({ success: false }) };

let key: string;
let id: string;
beforeEach(async () => {
  ({ id, key } = await createClient());
  await enablePush(id);
});

describe("gates", () => {
  it("answers 503 push_not_configured without VAPID settings", async () => {
    for (const missing of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]) {
      const res = await pushCall("/v1/push/public-key", { key }, undefined, { ...pushEnv, [missing]: "" } as Env);
      expect(res.status).toBe(503);
      expect(await code(res)).toBe("push_not_configured");
    }
  });

  it("answers 403 push_disabled until the client enables push", async () => {
    await enablePush(id, false);
    const res = await pushCall("/v1/push/public-key", { key });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("push_disabled");
  });

  it("DELETE works when push is disabled or not configured", async () => {
    await enablePush(id, false);
    expect((await del(key, { user_id: "u1" })).status).toBe(204);
    expect((await del(key, { user_id: "u1" }, { ...pushEnv, VAPID_PUBLIC_KEY: "" } as Env)).status).toBe(204);
  });

  it("routes unknown push paths and wrong methods before the gates", async () => {
    await enablePush(id, false);
    const nope = await pushCall("/v1/push/nope", { key });
    expect(nope.status).toBe(404);
    expect(await code(nope)).toBe("not_found");
    expect((await pushCall("/v1/push/subscriptions", { key })).status).toBe(405);
    expect((await pushCall("/v1/push/constructor", { key })).status).toBe(404);
  });

  it("push routes use PUSH_RATE_LIMITER, not CLIENT_RATE_LIMITER", async () => {
    const path = "/v1/push/public-key";
    expect((await pushCall(path, { key }, undefined, { ...pushEnv, CLIENT_RATE_LIMITER: deny } as Env)).status).toBe(200);
    const limited = await pushCall(path, { key }, undefined, { ...pushEnv, PUSH_RATE_LIMITER: deny } as Env);
    expect(limited.status).toBe(429);
    expect(await code(limited)).toBe("rate_limited");
    expect((await call("/v1/templates", { key }, undefined, { ...env, PUSH_RATE_LIMITER: deny } as Env)).status).toBe(200);
  });
});

it("returns the VAPID public key", async () => {
  const res = await pushCall("/v1/push/public-key", { key });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ public_key: VAPID_TEST.publicKey });
});

describe("registering", () => {
  it("registers, moves and caps subscriptions", async () => {
    expect((await put(key, { user_id: "u1", subscription: sub(E) })).status).toBe(204);
    expect(await rows(id)).toEqual([{ endpoint: E, user_id: "u1" }]);

    await put(key, { user_id: "u2", subscription: sub(E) });
    expect(await rows(id)).toEqual([{ endpoint: E, user_id: "u2" }]);

    for (let i = 0; i <= 10; i++) await put(key, { user_id: "u3", subscription: sub(`https://fcm.googleapis.com/fcm/send/e${i}`) });
    const u3 = (await rows(id)).filter((r) => r.user_id === "u3").map((r) => r.endpoint.split("/").pop());
    expect(u3.sort()).toEqual(["e1", "e10", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"]);
  });

  it("accepts every allowlisted push service", async () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/x",
      "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
      "https://web.push.apple.com/x",
    ]) {
      expect((await put(key, { user_id: "u1", subscription: sub(endpoint) })).status, endpoint).toBe(204);
    }
  });

  it("rejects endpoints outside the allowlist", async () => {
    for (const endpoint of ["https://fcm.googleapis.com.evil.com/x", "https://evil.com/x"]) {
      const res = await put(key, { user_id: "u1", subscription: sub(endpoint) });
      expect(res.status, endpoint).toBe(400);
      expect(await code(res)).toBe("unsupported_push_service");
    }
    for (const endpoint of [
      "http://fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://u:p@fcm.googleapis.com/x",
      "not a url",
      "https://fcm.googleapis.com/" + "a".repeat(2030),
    ]) {
      const res = await put(key, { user_id: "u1", subscription: sub(endpoint) });
      expect(res.status, endpoint).toBe(400);
      expect(await code(res)).toBe("validation_error");
    }
  });

  it("rejects bad keys and malformed bodies", async () => {
    const bytes = (n: number, first = 4) => b64url.encode(Uint8Array.from({ length: n }, (_, i) => (i === 0 ? first : 7)));
    const bodies: unknown[] = [
      { user_id: "u1", subscription: sub(E, { p256dh: bytes(64) }) },
      { user_id: "u1", subscription: sub(E, { p256dh: bytes(65, 3) }) },
      { user_id: "u1", subscription: sub(E, { auth: bytes(15) }) },
      { user_id: "u1", subscription: sub(E, { auth: "a+b/" }) },
      { user_id: "u1", subscription: null },
      { user_id: "u1", subscription: { endpoint: E, keys: "x" } },
      { user_id: "", subscription: sub(E) },
      { user_id: "a".repeat(129), subscription: sub(E) },
      { user_id: "a\nb", subscription: sub(E) },
    ];
    for (const body of bodies) {
      const res = await put(key, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await code(res)).toBe("validation_error");
    }
  });
});

describe("removing", () => {
  it("keeps the same endpoint separate per client", async () => {
    const other = await createClient("other-app");
    await enablePush(other.id);
    await put(key, { user_id: "u1", subscription: sub(E) });
    await put(other.key, { user_id: "u9", subscription: sub(E) });
    expect(await rows(id)).toEqual([{ endpoint: E, user_id: "u1" }]);

    expect((await del(other.key, { endpoint: E })).status).toBe(204);
    expect(await rows(other.id)).toEqual([]);
    expect(await rows(id)).toEqual([{ endpoint: E, user_id: "u1" }]);
  });

  it("deletes one device by endpoint or all by user_id", async () => {
    const e2 = "https://fcm.googleapis.com/fcm/send/e2";
    await put(key, { user_id: "u1", subscription: sub(E) });
    await put(key, { user_id: "u1", subscription: sub(e2) });
    await put(key, { user_id: "u2", subscription: sub("https://fcm.googleapis.com/fcm/send/e3") });

    expect((await del(key, { endpoint: E })).status).toBe(204);
    expect((await rows(id)).map((r) => r.endpoint)).toEqual([e2, "https://fcm.googleapis.com/fcm/send/e3"]);

    expect((await del(key, { user_id: "u1" })).status).toBe(204);
    expect(await rows(id)).toEqual([{ endpoint: "https://fcm.googleapis.com/fcm/send/e3", user_id: "u2" }]);

    for (const body of [{}, { endpoint: E, user_id: "u1" }]) {
      const res = await del(key, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await code(res)).toBe("validation_error");
    }
  });
});

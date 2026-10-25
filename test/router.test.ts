import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { handle } from "../src/index";

it("GET /health answers without auth", async () => {
  const res = await handle(new Request("https://notify.test/health"), env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

it("unknown routes return 404 not_found", async () => {
  const res = await handle(new Request("https://notify.test/nope"), env);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: "not_found", message: "Route not found" } });
});

it("wrong method returns 405", async () => {
  const res = await handle(new Request("https://notify.test/health", { method: "POST" }), env);
  expect(res.status).toBe(405);
  expect((await res.json<any>()).error.code).toBe("method_not_allowed");
});

it("rate limits /v1/* per IP before checking the API key", async () => {
  // A stub limiter: 600 real requests can straddle the limiter's 60 s window and reset its count.
  const keys: string[] = [];
  const IP_RATE_LIMITER = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } as RateLimit;
  const req = new Request("https://notify.test/v1/templates", { headers: { "CF-Connecting-IP": "203.0.113.7", "X-API-Key": "nf_wrong" } });
  const blocked = await handle(req, { ...env, IP_RATE_LIMITER });
  // A wrong key would answer 401: the 429 proves the IP check runs first.
  expect(blocked.status).toBe(429);
  expect((await blocked.json<any>()).error.code).toBe("rate_limited");
  expect(keys).toEqual(["203.0.113.7"]);
});

it("rejects an oversized API key as invalid", async () => {
  const res = await handle(new Request("https://notify.test/v1/templates", { headers: { "X-API-Key": "a".repeat(129) } }), env);
  expect(res.status).toBe(401);
});

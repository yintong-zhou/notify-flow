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
  const req = () =>
    handle(new Request("https://notify.test/v1/templates", { headers: { "CF-Connecting-IP": "203.0.113.7", "X-API-Key": "nf_wrong" } }), env);
  for (let i = 0; i < 300; i++) expect((await req()).status).toBe(401);
  const blocked = await req();
  expect(blocked.status).toBe(429);
  expect((await blocked.json<any>()).error.code).toBe("rate_limited");
});

it("rejects an oversized API key as invalid", async () => {
  const res = await handle(new Request("https://notify.test/v1/templates", { headers: { "X-API-Key": "a".repeat(129) } }), env);
  expect(res.status).toBe(401);
});

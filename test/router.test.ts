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

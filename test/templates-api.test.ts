import { describe, expect, it } from "vitest";
import { call, createClient } from "./helpers";

const custom = { subject: "Hi {{name}}", html: "<p>Hi {{name}}</p>", text: "Hi {{name}}", variables: ["name"] };

describe("authentication", () => {
  it("rejects missing and wrong keys", async () => {
    expect((await call("/v1/templates")).status).toBe(401);
    const res = await call("/v1/templates", { key: "nf_wrong" });
    expect(res.status).toBe(401);
    expect((await res.json<any>()).error.code).toBe("unauthorized");
  });

  it("accepts Bearer and X-API-Key", async () => {
    const { key } = await createClient();
    expect((await call("/v1/templates", { key })).status).toBe(200);
    expect((await call("/v1/templates", { headers: { "X-API-Key": key } })).status).toBe(200);
  });
});

describe("template CRUD", () => {
  it("lists the 18 built-ins for a new client", async () => {
    const { key } = await createClient();
    const list = await (await call("/v1/templates", { key })).json<any[]>();
    expect(list).toHaveLength(18);
    expect(list.every((t) => t.builtin === true && t.updated_at === null)).toBe(true);
  });

  it("creates, reads, overrides and isolates per client", async () => {
    const a = await createClient("a");
    const b = await createClient("b");

    const put = await call("/v1/templates/welcome/it", { key: a.key, method: "PUT", body: custom });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ name: "welcome", locale: "it", ...custom, builtin: false });

    const mine = await (await call("/v1/templates/welcome/it", { key: a.key })).json<any>();
    expect(mine).toMatchObject({ subject: "Hi {{name}}", builtin: false });

    const theirs = await (await call("/v1/templates/welcome/it", { key: b.key })).json<any>();
    expect(theirs).toMatchObject({ subject: "Benvenuto su {{appName}}", builtin: true });

    const list = await (await call("/v1/templates", { key: a.key })).json<any[]>();
    const welcomeIt = list.filter((t) => t.name === "welcome" && t.locale === "it");
    expect(welcomeIt).toHaveLength(1);
    expect(welcomeIt[0].builtin).toBe(false);
    expect(list).toHaveLength(18);
  });

  it("updates an existing template", async () => {
    const { key } = await createClient();
    await call("/v1/templates/invoice/en", { key, method: "PUT", body: custom });
    await call("/v1/templates/invoice/en", { key, method: "PUT", body: { ...custom, subject: "v2 {{name}}" } });
    expect((await (await call("/v1/templates/invoice/en", { key })).json<any>()).subject).toBe("v2 {{name}}");
  });

  it("deletes only the client's own templates", async () => {
    const { key } = await createClient();
    await call("/v1/templates/invoice/en", { key, method: "PUT", body: custom });
    expect((await call("/v1/templates/invoice/en", { key, method: "DELETE" })).status).toBe(204);
    expect((await call("/v1/templates/invoice/en", { key, method: "DELETE" })).status).toBe(404);
    expect((await call("/v1/templates/welcome/en", { key, method: "DELETE" })).status).toBe(404);
    expect((await call("/v1/templates/invoice/en", { key })).status).toBe(404);
  });
});

describe("template validation", () => {
  it.each([
    ["undeclared placeholder", "/v1/templates/x/en", { ...custom, variables: [] }],
    ["CR/LF in subject", "/v1/templates/x/en", { ...custom, subject: "a\r\nBcc: x@y.z" }],
    ["bad variable name", "/v1/templates/x/en", { ...custom, variables: ["name", "bad-name"] }],
    ["bad template name", "/v1/templates/Bad_Name/en", custom],
    ["unsupported locale", "/v1/templates/x/fr", custom],
    ["subject too long", "/v1/templates/x/en", { ...custom, subject: "a".repeat(256) }],
    ["html over 100 KB", "/v1/templates/x/en", { ...custom, html: "a".repeat(100 * 1024 + 1) }],
  ] as [string, string, unknown][])("rejects %s with 400", async (_label, path, body) => {
    const { key } = await createClient();
    const res = await call(path, { key, method: "PUT", body });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe("validation_error");
  });

  it("rejects invalid JSON and oversized bodies", async () => {
    const { key } = await createClient();
    const bad = await call("/v1/templates/x/en", { key, method: "PUT", rawBody: "{nope" });
    expect((await bad.json<any>()).error.code).toBe("invalid_json");
    const big = await call("/v1/templates/x/en", { key, method: "PUT", rawBody: "a".repeat(256 * 1024 + 1) });
    expect(big.status).toBe(413);
  });

  it("returns 405 for unsupported methods", async () => {
    const { key } = await createClient();
    expect((await call("/v1/templates/x/en", { key, method: "PATCH", body: custom })).status).toBe(405);
  });
});

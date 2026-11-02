import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { enabledLocales } from "../src/security/validation";
import { call, createClient, enablePush, pushCall, pushEnv, recorder } from "./helpers";

const restricted = { ...env, LOCALES: "it,en,zh-CN" } as Env;
const welcome = (locale: string) => ({
  template: "welcome",
  to: `${crypto.randomUUID()}@example.com`,
  locale,
  variables: { appName: "Acme", name: "Mario" },
});
const rejects = async (res: Response, field = "locale") => {
  expect(res.status).toBe(400);
  expect((await res.json<any>()).error).toMatchObject({ code: "validation_error", message: `${field} must be one of it, en, zh-CN` });
};

describe("enabledLocales", () => {
  it("defaults to every supported locale", () => {
    expect(enabledLocales({ LOCALES: "" })).toEqual(["it", "en", "pt-BR", "zh-CN"]);
  });

  it("keeps the listed supported locales and ignores unknown entries", () => {
    expect(enabledLocales({ LOCALES: " it, en ,zh-CN " })).toEqual(["it", "en", "zh-CN"]);
    expect(enabledLocales({ LOCALES: "it,fr" })).toEqual(["it"]);
    expect(enabledLocales({ LOCALES: "fr" })).toEqual([]);
  });
});

describe("zh-CN", () => {
  it("is accepted and renders the built-in template", async () => {
    const { key } = await createClient();
    const rec = recorder();
    const res = await call("/v1/email/send", { key, method: "POST", body: welcome("zh-CN") }, rec.send);
    expect(res.status).toBe(200);
    expect(rec.messages[0].subject).toBe("欢迎加入 Acme");
  });
});

describe("LOCALES restricts the deployment", () => {
  it("rejects a disabled locale on /v1/email/send and still sends an enabled one", async () => {
    const { key } = await createClient();
    const rec = recorder();
    await rejects(await call("/v1/email/send", { key, method: "POST", body: welcome("pt-BR") }, rec.send, restricted));
    const ok = await call("/v1/email/send", { key, method: "POST", body: welcome("zh-CN") }, rec.send, restricted);
    expect(ok.status).toBe(200);
    expect(rec.messages).toHaveLength(1);
  });

  it("accepts every supported locale when empty", async () => {
    const { key } = await createClient();
    const res = await call("/v1/email/send", { key, method: "POST", body: welcome("pt-BR") }, recorder().send, { ...env, LOCALES: "" } as Env);
    expect(res.status).toBe(200);
  });

  it("rejects a disabled locale on /v1/notifications", async () => {
    const { key } = await createClient();
    const body = {
      event: "user.welcome",
      recipient: { email: `${crypto.randomUUID()}@example.com`, locale: "pt-BR" },
      data: { appName: "Acme", name: "Mario" },
    };
    await rejects(await call("/v1/notifications", { key, method: "POST", body }, recorder().send, restricted), "recipient.locale");
  });

  it("rejects a disabled locale on /v1/templates and hides its built-ins from the list", async () => {
    const { key } = await createClient();
    await rejects(await call("/v1/templates/welcome/pt-BR", { key }, undefined, restricted));
    const custom = { subject: "Hi {{name}}", html: "<p>{{name}}</p>", text: "{{name}}", variables: ["name"] };
    await rejects(await call("/v1/templates/welcome/pt-BR", { key, method: "PUT", body: custom }, undefined, restricted));
    await rejects(await call("/v1/templates/welcome/pt-BR", { key, method: "DELETE" }, undefined, restricted));
    const list = await (await call("/v1/templates", { key }, undefined, restricted)).json<{ locale: string }[]>();
    expect(new Set(list.map((t) => t.locale))).toEqual(new Set(["it", "en", "zh-CN"]));
  });

  it("rejects a disabled locale on /v1/push/send", async () => {
    const { id, key } = await createClient();
    await enablePush(id);
    const body = { user_id: "u1", template: "new-message", locale: "pt-BR", variables: { appName: "Acme", sender: "Ana" } };
    await rejects(await pushCall("/v1/push/send", { key, method: "POST", body }, undefined, { ...pushEnv, LOCALES: "it,en,zh-CN" } as Env));
  });
});

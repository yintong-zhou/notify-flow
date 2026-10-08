import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listBuiltins, builtinTemplate } from "../src/templates/defaults";
import { checkVariables, placeholders, render, resolveTemplate } from "../src/templates/renderer";
import type { Template } from "../src/types";
import { createClient, insertTemplate } from "./helpers";

const tpl: Template = { subject: "Hi {{name}}", html: "<p>{{ name }}</p>", text: "Hi {{name}}", variables: ["name"] };

describe("render", () => {
  it("escapes HTML in the html part only", () => {
    const out = render(tpl, { name: `<b>"x" & 'y'</b>` });
    expect(out.html).toBe("<p>&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;</p>");
    expect(out.text).toBe(`Hi <b>"x" & 'y'</b>`);
  });

  it("strips CR/LF from subject values (header injection)", () => {
    expect(render(tpl, { name: "a\r\nBcc: evil@example.com" }).subject).toBe("Hi aBcc: evil@example.com");
  });

  it("does not expand placeholders inside values", () => {
    expect(render(tpl, { name: "{{name}}" }).text).toBe("Hi {{name}}");
  });

  it("lists placeholders, tolerating inner spaces", () => {
    expect(placeholders("{{a}} {{ b }} {{a}}")).toEqual(["a", "b", "a"]);
  });
});

describe("checkVariables", () => {
  it("accepts exactly the declared variables", () => {
    expect(() => checkVariables(tpl, { name: "x" })).not.toThrow();
  });

  it("rejects missing and unexpected variables", () => {
    expect(() => checkVariables(tpl, {})).toThrow(/missing: \[name\]/);
    expect(() => checkVariables(tpl, { name: "x", other: "y" })).toThrow(/unexpected: \[other\]/);
  });
});

describe("built-in templates", () => {
  it("ship 6 templates in it, en and pt-BR", () => {
    expect(listBuiltins()).toHaveLength(18);
  });

  it("declare every placeholder they use", () => {
    for (const { name, locale } of listBuiltins()) {
      const t = builtinTemplate(name, locale)!;
      const used = placeholders(t.subject + t.html + t.text);
      expect(used.filter((p) => !t.variables.includes(p)), `${name}/${locale}`).toEqual([]);
    }
  });
});

describe("resolveTemplate", () => {
  it("uses the built-in template when the client has none", async () => {
    const { id } = await createClient();
    expect((await resolveTemplate(env.DB, id, "welcome", "it")).subject).toBe("Benvenuto su {{appName}}");
  });

  it("prefers the client's template for that locale only", async () => {
    const { id } = await createClient();
    await insertTemplate(id, "welcome", "it", { ...tpl, subject: "Custom" });
    expect((await resolveTemplate(env.DB, id, "welcome", "it")).subject).toBe("Custom");
    expect((await resolveTemplate(env.DB, id, "welcome", "pt-BR")).subject).toBe("Boas-vindas ao {{appName}}");
  });

  it("falls back to en", async () => {
    const { id } = await createClient();
    await insertTemplate(id, "invoice", "en", { ...tpl, subject: "Invoice" });
    expect((await resolveTemplate(env.DB, id, "invoice", "it")).subject).toBe("Invoice");
  });

  it("does not leak another client's templates", async () => {
    const a = await createClient();
    const b = await createClient();
    await insertTemplate(a.id, "invoice", "en", tpl);
    await expect(resolveTemplate(env.DB, b.id, "invoice", "en")).rejects.toMatchObject({ status: 404, code: "template_not_found" });
  });

  it("does not resolve Object.prototype names", async () => {
    const { id } = await createClient();
    await expect(resolveTemplate(env.DB, id, "constructor", "en")).rejects.toMatchObject({ code: "template_not_found" });
    await expect(resolveTemplate(env.DB, id, "tostring", "en")).rejects.toMatchObject({ code: "template_not_found" });
  });
});

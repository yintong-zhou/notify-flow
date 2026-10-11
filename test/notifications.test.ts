import { describe, expect, it } from "vitest";
import { call, createClient, insertTemplate } from "./helpers";

const custom = { subject: "Reset {{name}}", html: "<p>{{name}} {{link}}</p>", text: "{{name}} {{link}}", variables: ["name", "link"] };
const putEvent = (key: string, event: string, body: unknown) => call(`/v1/events/${event}`, { key, method: "PUT", body });

describe("/v1/events", () => {
  it("lists the built-in events for a new client", async () => {
    const { key } = await createClient();
    const res = await call("/v1/events", { key });
    expect(res.status).toBe(200);
    const list = await res.json<any[]>();
    expect(list).toHaveLength(6);
    expect(list).toContainEqual({ event: "auth.password_reset", template: "password-reset", builtin: true, updated_at: null });
  });

  it("overrides a built-in event and restores it on delete", async () => {
    const { id: clientId, key } = await createClient();
    await insertTemplate(clientId, "my-reset", "en", custom);
    const put = await putEvent(key, "auth.password_reset", { template: "my-reset" });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ event: "auth.password_reset", template: "my-reset", builtin: false });
    const list = await (await call("/v1/events", { key })).json<any[]>();
    expect(list).toHaveLength(6);
    expect(list.filter((e) => e.event === "auth.password_reset")).toEqual([
      { event: "auth.password_reset", template: "my-reset", builtin: false, updated_at: expect.any(Number) },
    ]);

    expect((await call("/v1/events/auth.password_reset", { key, method: "DELETE" })).status).toBe(204);
    const restored = await call("/v1/events/auth.password_reset", { key });
    expect(await restored.json()).toEqual({ event: "auth.password_reset", template: "password-reset", builtin: true });
  });

  it("adds a new event pointing to a built-in template", async () => {
    const { key } = await createClient();
    expect((await putEvent(key, "billing.invoice_ready", { template: "generic-notification" })).status).toBe(200);
    const res = await call("/v1/events/billing.invoice_ready", { key });
    expect(await res.json()).toEqual({ event: "billing.invoice_ready", template: "generic-notification", builtin: false });
  });

  it("rejects a mapping to a template that does not exist", async () => {
    const { key } = await createClient();
    const res = await putEvent(key, "billing.invoice_ready", { template: "no-such-template" });
    expect(res.status).toBe(404);
    expect((await res.json<any>()).error.code).toBe("template_not_found");
  });

  it("rejects invalid event and template names", async () => {
    const { key } = await createClient();
    for (const event of ["nodot", "Auth.Reset", "auth..reset", `a.${"b".repeat(63)}`]) {
      const res = await putEvent(key, event, { template: "welcome" });
      expect(res.status, event).toBe(400);
      expect((await res.json<any>()).error.code).toBe("validation_error");
    }
    expect((await putEvent(key, "billing.x", { template: "Bad Name" })).status).toBe(400);
  });

  it("keeps mappings separate for each client", async () => {
    const a = await createClient("a");
    const b = await createClient("b");
    expect((await putEvent(a.key, "billing.invoice_ready", { template: "welcome" })).status).toBe(200);
    expect((await call("/v1/events/billing.invoice_ready", { key: b.key })).status).toBe(404);
    expect((await call("/v1/events/billing.invoice_ready", { key: b.key, method: "DELETE" })).status).toBe(404);
  });

  it("answers 404 for unknown events and for deleting a built-in", async () => {
    const { key } = await createClient();
    const del = await call("/v1/events/auth.password_reset", { key, method: "DELETE" });
    expect(del.status).toBe(404);
    expect((await del.json<any>()).error.code).toBe("event_not_found");
    expect((await call("/v1/events/nobody.knows", { key })).status).toBe(404);
  });

  it("allows only GET on the list", async () => {
    const { key } = await createClient();
    expect((await call("/v1/events", { key, method: "POST", body: {} })).status).toBe(405);
  });
});

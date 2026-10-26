import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { adminCall, createClient, enablePush, pushCall, pushEnv, setupAdmin } from "./helpers";

// RFC 8291 section 5 browser keys, verbatim.
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

const code = async (res: Response) => (await res.json<any>()).error.code;
const pushFlag = (id: string) => env.DB.prepare("SELECT push_enabled FROM clients WHERE id = ?").bind(id).first<number>("push_enabled");
const toggle = (cookie: string | undefined, body: unknown, testEnv?: Env) => adminCall("client-push", { cookie, body }, testEnv);

let cookie: string;
beforeEach(async () => {
  cookie = await setupAdmin();
});

describe("admin clients", () => {
  it("requires a session", async () => {
    expect((await adminCall("clients")).status).toBe(401);
    expect((await toggle(undefined, { client_id: "cl_x", enabled: true }, pushEnv)).status).toBe(401);
  });

  it("lists clients with push state and device count", async () => {
    const { id, key } = await createClient("shop");
    await enablePush(id);
    for (const n of [1, 2]) {
      const res = await pushCall("/v1/push/subscriptions", {
        key,
        method: "PUT",
        body: { user_id: "u1", subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: UA_PUBLIC, auth: AUTH } } },
      });
      expect(res.status).toBe(204);
    }
    const res = await adminCall("clients", { cookie }, pushEnv);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.push_configured).toBe(true);
    expect(body.clients).toContainEqual({ id, name: "shop", created_at: expect.any(Number), push_enabled: true, push_devices: 2 });
    expect((await (await adminCall("clients", { cookie })).json<any>()).push_configured).toBe(false);
  });

  it("sorts clients by name", async () => {
    await createClient("zeta");
    await createClient("alpha");
    const names = (await (await adminCall("clients", { cookie })).json<any>()).clients.map((c: any) => c.name);
    expect(names).toEqual([...names].sort());
  });

  it("toggles push for a client", async () => {
    const { id } = await createClient();
    expect((await toggle(cookie, { client_id: id, enabled: true }, pushEnv)).status).toBe(204);
    expect(await pushFlag(id)).toBe(1);
    expect((await toggle(cookie, { client_id: id, enabled: false }, pushEnv)).status).toBe(204);
    expect(await pushFlag(id)).toBe(0);
  });

  it("refuses to enable push when it is not configured", async () => {
    const { id } = await createClient();
    const res = await toggle(cookie, { client_id: id, enabled: true });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("push_not_configured");
    expect(await pushFlag(id)).toBe(0);
    await enablePush(id);
    expect((await toggle(cookie, { client_id: id, enabled: false })).status).toBe(204);
    expect(await pushFlag(id)).toBe(0);
  });

  it("validates the toggle", async () => {
    const { id } = await createClient();
    const unknown = await toggle(cookie, { client_id: "cl_nope", enabled: true }, pushEnv);
    expect(unknown.status).toBe(404);
    expect(await code(unknown)).toBe("not_found");
    for (const body of [{ client_id: id, enabled: "yes" }, { enabled: true }, { client_id: 5, enabled: true }]) {
      const res = await toggle(cookie, body, pushEnv);
      expect(res.status).toBe(400);
      expect(await code(res)).toBe("validation_error");
    }
    const plain = await adminCall("client-push", {
      method: "POST",
      cookie,
      headers: { "Content-Type": "text/plain" },
      body: { client_id: id, enabled: true },
    });
    expect(plain.status).toBe(415);
  });
});

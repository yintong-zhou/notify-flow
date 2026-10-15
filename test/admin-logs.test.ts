import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { adminCall, createClient, setupAdmin } from "./helpers";

let cookie: string;
let clientId: string;

async function insert(level: string, code: string, extra: { client_id?: string; message_id?: string; ip?: string } = {}): Promise<number> {
  return (await env.DB.prepare("INSERT INTO app_logs (created_at, level, code, client_id, message_id, ip) VALUES (unixepoch(), ?, ?, ?, ?, ?) RETURNING id")
    .bind(level, code, extra.client_id ?? null, extra.message_id ?? null, extra.ip ?? null)
    .first<number>("id"))!;
}

async function get(query = ""): Promise<any> {
  const res = await adminCall(`logs${query}`, { cookie });
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM app_logs").run();
  cookie = await setupAdmin();
  clientId = (await createClient("shop")).id;
});

describe("GET /admin/api/logs", () => {
  it("requires a session, and logs that rejection as a warn with no client", async () => {
    expect((await adminCall("logs")).status).toBe(401);
    expect(await env.DB.prepare("SELECT level, code, client_id, path FROM app_logs").first()).toEqual({
      level: "warn", code: "unauthorized", client_id: null, path: "/admin/api/logs",
    });
  });

  it("filters by each field and names the client", async () => {
    const target = await insert("error", "smtp_failed", { client_id: clientId, message_id: "msg_x", ip: "203.0.113.7" });
    await insert("warn", "unauthorized", { ip: "198.51.100.1" });
    const ids = async (query: string) => (await get(`?${query}`)).logs.map((l: any) => l.id);
    for (const query of ["level=error", "code=smtp_failed", `client_id=${clientId}`, "ip=203.0.113.7", "message_id=msg_x"]) {
      expect(await ids(query)).toEqual([target]);
    }
    expect((await get()).logs.map((l: any) => l.client_name)).toEqual([null, "shop"]);
  });

  it("pages newest first by id and never repeats a row", async () => {
    for (let i = 0; i < 55; i++) await insert("info", `code_${i}`);
    const first = await get();
    expect(first.logs).toHaveLength(50);
    const second = await get(`?before=${first.next}`);
    expect(second.logs).toHaveLength(5);
    expect(second.next).toBeNull();
    const seen = [...first.logs, ...second.logs].map((l: any) => l.code);
    expect(new Set(seen).size).toBe(55);
    expect(seen[0]).toBe("code_54");
  });

  it("rejects a bad level or cursor, and is not cacheable", async () => {
    for (const query of ["level=fatal", "before=abc", "before=0", "before=-1"]) {
      expect((await adminCall(`logs?${query}`, { cookie })).status).toBe(400);
    }
    expect((await adminCall("logs", { cookie })).headers.get("Cache-Control")).toBe("no-store");
  });
});

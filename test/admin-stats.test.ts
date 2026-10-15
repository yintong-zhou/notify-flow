import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { adminCall, createClient, setupAdmin } from "./helpers";

const HOUR = 3600;
const DAY = 86400;
let cookie: string;
let clientId: string;

interface Row { status: string; age: number; error_code?: string; template?: string; recipient?: string; claimed_age?: number }

/** Inserts a delivery created `age` seconds ago (claimed `claimed_age` seconds ago, if set) and returns its id. */
async function insert(row: Row): Promise<string> {
  const id = `msg_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO email_deliveries (id, request_id, client_id, template, provider, recipient, status, error_code, created_at, claimed_at)
     VALUES (?, ?, ?, ?, 'gmail', ?, ?, ?, unixepoch() - ?, unixepoch() - ?)`,
  )
    .bind(id, crypto.randomUUID(), clientId, row.template ?? "welcome", row.recipient ?? "a@example.com", row.status,
      row.error_code ?? null, row.age, row.claimed_age ?? null)
    .run();
  return id;
}

async function get(path: string): Promise<any> {
  const res = await adminCall(path, { cookie });
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM email_deliveries").run();
  cookie = await setupAdmin();
  clientId = (await createClient("shop")).id;
});

describe("GET /admin/api/stats", () => {
  it("requires a session, not an API key", async () => {
    const { key } = await createClient();
    expect((await adminCall("stats")).status).toBe(401);
    expect((await adminCall("stats", { headers: { Authorization: `Bearer ${key}` } })).status).toBe(401);
  });

  it("returns zeros and empty lists when nothing was sent", async () => {
    expect(await get("stats")).toEqual({
      window: "24h",
      by_status: { accepted: 0, queued: 0, processing: 0, retrying: 0, submitted: 0, failed: 0, stalled: 0 },
      errors: [],
      series: [],
    });
  });

  it("counts statuses inside the window only, and flags stalled processing rows", async () => {
    await insert({ status: "submitted", age: HOUR });
    await insert({ status: "submitted", age: 2 * HOUR });
    await insert({ status: "failed", age: HOUR, error_code: "smtp_failed" });
    await insert({ status: "processing", age: 10 }); // fresh
    await insert({ status: "processing", age: 2 * HOUR }); // sync path, stuck
    await insert({ status: "processing", age: 2 * HOUR, claimed_age: 60 }); // queue path, claimed recently
    await insert({ status: "submitted", age: 2 * DAY }); // outside 24h
    expect((await get("stats")).by_status).toMatchObject({ submitted: 2, failed: 1, processing: 3, stalled: 1 });
    expect((await get("stats?window=7d")).by_status.submitted).toBe(3);
  });

  it("ranks errors by code, client and template", async () => {
    for (let i = 0; i < 3; i++) await insert({ status: "failed", age: HOUR, error_code: "smtp_failed" });
    await insert({ status: "failed", age: HOUR, error_code: "abandoned", template: "reset" });
    await insert({ status: "submitted", age: HOUR });
    expect((await get("stats")).errors).toEqual([
      { error_code: "smtp_failed", client_id: clientId, client_name: "shop", template: "welcome", count: 3 },
      { error_code: "abandoned", client_id: clientId, client_name: "shop", template: "reset", count: 1 },
    ]);
  });

  it("buckets the series by hour for 24h and by UTC day for 7d and 30d", async () => {
    const id = await insert({ status: "submitted", age: 3 * HOUR });
    const created = (await env.DB.prepare("SELECT created_at FROM email_deliveries WHERE id = ?").bind(id).first<number>("created_at"))!;
    const hourly = (await get("stats")).series;
    expect(hourly).toContainEqual({ bucket: created - (created % HOUR), status: "submitted", count: 1 });
    expect(hourly.every((p: any) => p.bucket % HOUR === 0)).toBe(true);
    const daily = (await get("stats?window=7d")).series;
    expect(daily).toContainEqual({ bucket: created - (created % DAY), status: "submitted", count: 1 });
    expect(daily.every((p: any) => p.bucket % DAY === 0)).toBe(true);
    expect((await get("stats?window=30d")).series).toEqual(daily);
  });

  it("marks admin API responses as not cacheable", async () => {
    const res = await adminCall("deliveries", { cookie });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects an unknown window", async () => {
    const res = await adminCall("stats?window=1y", { cookie });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe("validation_error");
  });
});

describe("GET /admin/api/deliveries", () => {
  it("requires a session", async () => {
    expect((await adminCall("deliveries")).status).toBe(401);
  });

  it("filters by each field, matching the recipient in any case", async () => {
    const target = await insert({ status: "failed", age: 60, error_code: "smtp_failed", template: "reset", recipient: "bob@example.com" });
    await insert({ status: "submitted", age: 60 });
    const ids = async (query: string) => (await get(`deliveries?${query}`)).deliveries.map((d: any) => d.id);
    for (const query of ["recipient=BOB@example.com", "status=failed", "error_code=smtp_failed", "template=reset", `id=${target}`]) {
      expect(await ids(query)).toEqual([target]);
    }
    expect(await ids(`client_id=${clientId}`)).toHaveLength(2);
    expect(await ids("client_id=cl_other")).toEqual([]);
  });

  it("returns every column plus the client name", async () => {
    const id = await insert({ status: "submitted", age: 60 });
    expect((await get("deliveries")).deliveries).toEqual([
      expect.objectContaining({ id, client_id: clientId, client_name: "shop", template: "welcome", recipient: "a@example.com",
        status: "submitted", attempts: 0, error_code: null, sent_at: null }),
    ]);
  });

  it("pages newest first with a cursor and never repeats a row, even with equal timestamps", async () => {
    const inserted: string[] = [];
    for (let i = 0; i < 55; i++) inserted.push(await insert({ status: "submitted", age: i % 3 }));
    const first = await get("deliveries");
    expect(first.deliveries).toHaveLength(50);
    expect(first.next).toMatch(/^\d+:msg_/);
    const second = await get(`deliveries?before=${encodeURIComponent(first.next)}`);
    expect(second.deliveries).toHaveLength(5);
    expect(second.next).toBeNull();
    const seen = [...first.deliveries, ...second.deliveries].map((d: any) => d.id);
    expect(new Set(seen)).toEqual(new Set(inserted));
    expect(seen).toHaveLength(55);
  });

  it("rejects an unknown status or a malformed cursor", async () => {
    for (const query of ["status=delivered", "before=abc", "before=1:not-an-id"]) {
      expect((await adminCall(`deliveries?${query}`, { cookie })).status).toBe(400);
    }
  });
});

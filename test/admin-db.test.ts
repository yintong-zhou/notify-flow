import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { adminCall, setupAdmin } from "./helpers";

let cookie: string;
const run = (sql: unknown) => adminCall("sql", { cookie, body: { sql } });

async function ok(sql: string): Promise<any> {
  const res = await run(sql);
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_logs"),
    env.DB.prepare("DROP TABLE IF EXISTS scratch"),
    env.DB.prepare("CREATE TABLE scratch (id INTEGER PRIMARY KEY, name TEXT)"),
  ]);
  cookie = await setupAdmin();
});

describe("POST /admin/api/sql", () => {
  it("requires a session, JSON and POST", async () => {
    expect((await adminCall("sql", { body: { sql: "SELECT 1" } })).status).toBe(401);
    expect((await adminCall("sql", { cookie, method: "POST" })).status).toBe(415);
    expect((await adminCall("sql", { cookie })).status).toBe(405);
  });

  it("returns the columns, rows and meta of a SELECT", async () => {
    await ok("INSERT INTO scratch (id, name) VALUES (1, 'a'), (2, 'b')");
    const data = await ok("SELECT id, name FROM scratch ORDER BY id");
    expect(data).toMatchObject({ columns: ["id", "name"], rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }], truncated: false });
    expect(Object.keys(data.meta).sort()).toEqual(["changes", "duration", "rows_read", "rows_written"]);
  });

  it("writes, and reports the changes", async () => {
    await ok("INSERT INTO scratch (id, name) VALUES (1, 'a'), (2, 'b')");
    expect(await ok("UPDATE scratch SET name = 'z'")).toMatchObject({ columns: [], rows: [], meta: { changes: 2 } });
    expect(await env.DB.prepare("SELECT name FROM scratch WHERE id = 2").first("name")).toBe("z");
  });

  it("returns no columns when no row matches", async () => {
    expect(await ok("SELECT * FROM scratch WHERE id = 99")).toMatchObject({ columns: [], rows: [] });
  });

  it("returns at most 1000 rows and flags the cut", async () => {
    const data = await ok("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500) SELECT i FROM n");
    expect(data.rows).toHaveLength(1000);
    expect(data.rows[999]).toEqual({ i: 1000 });
    expect(data.truncated).toBe(true);
  });

  it("runs every statement of a string and returns the last one's rows", async () => {
    expect((await ok("INSERT INTO scratch (id, name) VALUES (1, 'a'); SELECT name FROM scratch")).rows).toEqual([{ name: "a" }]);
  });

  it("rolls back every statement of a string when a later one fails", async () => {
    // A runtime failure (duplicate key), not a syntax error that would stop the string before anything runs.
    expect((await run("INSERT INTO scratch (id, name) VALUES (1, 'a'); INSERT INTO scratch (id, name) VALUES (1, 'b')")).status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scratch").first("n")).toBe(0);
  });

  it("collapses duplicate column names into the last one", async () => {
    expect(await ok("SELECT 1 AS id, 2 AS id")).toMatchObject({ columns: ["id"], rows: [{ id: 2 }] });
  });

  it("rejects missing, blank, non-string or over-long sql", async () => {
    for (const sql of [undefined, "", "   \n", 42, "x".repeat(100_001)]) {
      const res = await run(sql);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.code).toBe("validation_error");
    }
  });

  it("gives D1's error to the admin but logs only the code", async () => {
    const res = await run("SELEC secret_value FROM clients");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toMatchObject({ code: "sql_error" });
    expect(body.error.message).toContain("syntax error");
    const { results } = await env.DB.prepare("SELECT * FROM app_logs").all();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ level: "info", code: "sql_error", status: 400, path: "/admin/api/sql", detail: null });
    expect(JSON.stringify(results)).not.toContain("secret_value");
  });
});

# Admin DB Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a Database section in the admin dashboard that browses every D1 table and runs any SQL statement, reads and writes.

**Architecture:**
- One endpoint, `POST /admin/api/sql`, a `runSql` handler in `src/admin/routes.ts` behind `withSession` and `requireJson`. It runs `env.DB.prepare(sql).all()` and returns columns, at most 1000 rows, `truncated` and four meta fields.
- D1 errors become `400 sql_error` carrying D1's message. `errorResponse` logs only code, status, method, path and IP.
- The UI (`public/admin/db.js`) builds the table list and the table pages as SQL sent through the same endpoint.

**Tech Stack:** TypeScript on Cloudflare Workers, D1, vanilla JS, vitest in workerd. No runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-10-15-admin-db-editor-design.md`](../specs/2026-10-15-admin-db-editor-design.md)

**Branch:** `feat/admin-db`, already created on top of `feat/admin-dashboard` (spec committed as `cffdfba`).

**Parts:**
1. This file: constraints, review focus, file map, Task 1 (API).
2. [Part 2](2026-10-15-admin-db-editor-part2.md): Task 2 (UI and headless check), Task 3 (docs).

## Global Constraints

- **No runtime dependencies.** `vi.mock` does not work in the Workers pool.
- **D1 state is shared between the tests of a file:** the new test file resets what it touches in `beforeEach`.
- **Never in a log:** the SQL text, D1's error message, row values. Only `errorResponse` → `logRequestError` logs, and it already writes code/status/method/path/ip only. Do not add any `log()` or `console.*` call.
- **Exact values:** max SQL length 100 000 characters; max 1000 rows returned; 50 rows per table page (`LIMIT 51` to detect a next page); error code `sql_error` (400); bad input `validation_error` (400, via `invalid()`); meta fields `changes`, `rows_read`, `rows_written`, `duration`.
- **Values from the DB go into the page through `textContent` only**, never `innerHTML`.
- **Markdown under 200 lines.**
- **Commands:** `npx vitest run <file>`, `npm test`, `npm run typecheck`, `node --check <file.js>`, `npm run docs:build`.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Several statements in one Run** (`INSERT …; SELECT …`): D1 runs all of them and returns the last one's rows; the admin must not believe only the first ran. Pinned by a Task 1 test; stated in the Task 3 docs.
2. **Whitespace-only SQL** answers `400 validation_error`, not D1's "No SQL statements detected" as `sql_error`. Task 1 test.
3. **Duplicate column names** (`SELECT 1 AS id, 2 AS id`) collapse to the last one; `columns` lists `id` once. Task 1 test; Task 3 docs say to alias.
4. **HTML stored in a cell** (`templates.html`) shows as text, never as markup. Task 2 headless check with a `<script>` value.
5. **A table name with a quote or `_cf_`-like letters** (`we"ird`, `xcfy`) is listed and browsable; only `sqlite_*` and `_cf_*` are hidden. Task 2 headless check.

## File map

| File | Change | Responsibility |
| --- | --- | --- |
| `src/admin/routes.ts` | modify | `runSql` handler and the `sql` route |
| `test/admin-db.test.ts` | create | API tests |
| `public/admin/index.html` | modify | Database section, `db.js` script tag |
| `public/admin/db.js` | create | table list, table pages, SQL box, result table |
| `public/admin/app.js` | modify | `refresh()` also calls `loadTables()` |
| `public/admin/style.css` | modify | textarea, status line, cell width |
| `docs/admin-dashboard.md`, `CLAUDE.md` | modify | docs |

---

### Task 1: `POST /admin/api/sql`

**Files:**
- Modify: `src/admin/routes.ts` (new handler before `const ROUTES`, one line in `ROUTES`, imports)
- Test: `test/admin-db.test.ts`

**Interfaces:**
- Consumes: `requireJson(req)` and `withSession(handler)` in `routes.ts`; `readJson(req): Promise<Record<string, unknown>>` and `invalid(message): never` from `src/security/validation.ts`; `HttpError(status, code, message)` from `src/types`; test helpers `adminCall(path, { cookie, body, method })` and `setupAdmin(): Promise<string>` from `test/helpers.ts`.
- Produces: `POST /admin/api/sql` with body `{ sql: string }` → `200 { columns: string[], rows: object[], truncated: boolean, meta: { changes, rows_read, rows_written, duration } }`, or `400 { error: { code: "sql_error" | "validation_error", message } }`. Task 2 calls it through `api("sql", { sql })`.

- [ ] **Step 1: Write the failing tests** in `test/admin-db.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to see them fail.** `npx vitest run test/admin-db.test.ts`. Expected: all 9 fail, with 404 `not_found` where a status is checked (the route does not exist yet).

Task 1 continues in [Part 2](2026-10-15-admin-db-editor-part2.md).

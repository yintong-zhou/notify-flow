# Admin DB editor — Design

Date: 2026-10-15
Builds on: [Admin dashboard](2026-10-15-admin-dashboard-design.md) (sub-project 3 of its roadmap)

## Goal

**The D1 database from inside the dashboard:** the operator browses every table and runs any SQL statement, reads and writes, without opening the Cloudflare dashboard.

Success:
- A **Database** section lists the tables; one click shows a table 50 rows per page.
- A SQL box runs one statement and shows its rows, or its changes for a write.
- A failed statement shows D1's error message to the admin; no log row ever holds the SQL text or that message.

## Decisions

- **Writes allowed, no password re-check:** the session is the gate. The admin can change or drop anything, `admin_user` and `admin_sessions` included; the docs say so.
- **One endpoint:** `POST /admin/api/sql`. The table browser is client-side SQL through the same endpoint (`sqlite_master`, `SELECT * … LIMIT/OFFSET`): with free SQL, dedicated read endpoints would add code and no protection.
- **No new limiter:** `handleAdmin` already applies the per-IP limit, and every call needs a session.
- **Rejected:**
  - the Cloudflare D1 Console alone: the user wants it inside the dashboard;
  - separate `tables` / `rows` endpoints: more server code, same power;
  - proxying the Cloudflare D1 REST API: needs an account API token secret;
  - password confirmation for writes: the user chose the session as the only gate.

## API: `POST /admin/api/sql`

Session required (`withSession`), `Content-Type: application/json` required (`requireJson`, the CSRF guard; 415 otherwise). `Cache-Control: no-store` comes from `handleAdmin`.

Request: `{ "sql": "SELECT …" }`. `sql` must be a non-empty string of at most 100 000 characters, else `400 validation_error` (via `invalid()`).

The handler runs `env.DB.prepare(sql).all()` and answers `200`:

```json
{
  "columns": ["id", "name"],
  "rows": [{ "id": "c_1", "name": "demo" }],
  "truncated": false,
  "meta": { "changes": 0, "rows_read": 1, "rows_written": 0, "duration": 0.2 }
}
```

- `rows`: at most 1000; `truncated: true` when D1 returned more. D1 still reads them all, so the docs tell the admin to add `LIMIT`.
- `columns`: the keys of the first row; `[]` when there are no rows. Two result columns with the same name (a JOIN on `id`) collapse into one: the docs say to alias them.
- `meta`: copied from D1's result `meta`, only these four fields.
- Multiple statements in one string: whatever D1's `prepare().all()` does, pinned by a test in the plan. Supporting them is out of scope.

Errors:
- D1 throws → `400 sql_error` whose `message` is D1's error message (the admin needs it to fix the query).
- `errorResponse` logs it like any error response (`logRequestError`): `code`, `status`, `method`, `path`, `ip` only. The SQL text and D1's message never reach `app_logs` or `console.log` (constraint in `CLAUDE.md`: a statement can carry recipients or other data).

Code: `src/admin/sql.ts` (the handler), added to `ROUTES` in `src/admin/routes.ts` as `sql: { POST: withSession(sql) }`.

## UI: Database section

In `public/admin/index.html`, after Logs and before Account. Logic in a new `public/admin/db.js`, loaded with `<script src="db.js" defer>` after `app.js` (which is already 204 lines). Both are classic scripts, so `db.js` calls `app.js`'s global `api(path, body)` helper.

- **Tables:** on dashboard load, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`, one button per table.
- **Table view:** a click runs `SELECT * FROM "<name>" LIMIT 51 OFFSET <n>` (the name quoted, `"` doubled). 50 rows shown; the 51st only enables **Next**. **Prev** goes back 50. The SQL box is filled with the statement, so the admin can edit it.
- **SQL box:** a `<textarea>` and a **Run** button; Ctrl+Enter runs too.
- **Result:** a table with `columns` as headers; a status line `N rows · M changes · D ms`, plus "showing the first 1000" when `truncated`. Errors in the section's `role="alert"` paragraph.
- Every cell goes through `textContent`; `null` shows as `NULL`, objects as JSON.

The CSP in `public/_headers` already allows `script-src 'self'`.

## Testing (`test/admin-db.test.ts`)

`beforeEach` resets the admin and the touched tables, as the other admin tests do.

- 401 without a session; 415 without JSON; 405 on GET.
- `SELECT` returns `columns`, `rows`, `truncated: false` and `meta`.
- `UPDATE` returns `meta.changes`.
- A query with no rows returns `columns: []`.
- More than 1000 rows (a recursive CTE) returns 1000 rows and `truncated: true`.
- Empty, non-string or over-long `sql` → 400 `validation_error`.
- Invalid SQL → 400 `sql_error`; the `app_logs` row has code `sql_error` and its `detail` is null.
- Two statements in one string: pins D1's behaviour.

## Docs

- `docs/admin-dashboard.md`: a "Database" section — what it does, that writes are immediate and unrestricted, the 1000-row cap, aliasing duplicate columns, one statement per run. If the file passes 200 lines, split it.
- `CLAUDE.md`, "Admin" paragraph: stats and search only read `email_deliveries`; the Database section runs any SQL on D1.

## Out of scope

Inline cell editing, CSV export, query history, multiple statements per run, BLOB display (no table has a BLOB column).

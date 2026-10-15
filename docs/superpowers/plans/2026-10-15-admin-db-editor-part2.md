# Admin DB Editor Implementation Plan — Part 2

Back to [Part 1](2026-10-15-admin-db-editor.md) for the constraints, the review focus and Task 1's tests.

### Task 1 (continued)

- [ ] **Step 3: Implement.** In `src/admin/routes.ts` (it already imports `invalid`, `readJson` and `HttpError`), add before `const ROUTES`:

```ts
const MAX_SQL_CHARS = 100_000;
const MAX_SQL_ROWS = 1000;

/** Any statement on D1, reads and writes: the session is the only gate. Neither the SQL nor D1's message is ever logged. */
async function runSql(req: Request, env: Env): Promise<Response> {
  requireJson(req);
  const { sql } = await readJson(req);
  if (typeof sql !== "string" || !sql.trim() || sql.length > MAX_SQL_CHARS) invalid(`sql must be 1-${MAX_SQL_CHARS} characters`);
  let result: D1Result<Record<string, unknown>>;
  try {
    // With several statements D1 runs them all and returns the last one's rows.
    result = await env.DB.prepare(sql).all();
  } catch (e) {
    // For the admin's eyes: errorResponse logs the code and status, never the message.
    throw new HttpError(400, "sql_error", e instanceof Error ? e.message : "Query failed");
  }
  const { results, meta } = result;
  const rows = results.slice(0, MAX_SQL_ROWS);
  return Response.json({
    columns: rows[0] ? Object.keys(rows[0]) : [],
    rows,
    truncated: results.length > MAX_SQL_ROWS,
    meta: { changes: meta.changes, rows_read: meta.rows_read, rows_written: meta.rows_written, duration: meta.duration },
  });
}
```

  In `ROUTES`, after `logs`, add `sql: { POST: withSession(runSql) },`.

- [ ] **Step 4: Run.** `npx vitest run test/admin-db.test.ts` → 9 passed. Then `npm test` (the `router.test.ts` "rate limits /v1/* per IP" case is known flaky: rerun once if it alone fails) and `npm run typecheck` → clean.
- [ ] **Step 5: Commit.** `git add src/admin/routes.ts test/admin-db.test.ts`, message `feat(admin): SQL endpoint for the DB editor`.

### Task 2: Database section

**Files:** modify `public/admin/index.html`, `public/admin/app.js`, `public/admin/style.css`; create `public/admin/db.js`.

**Interfaces:**
- Consumes: `POST /admin/api/sql` (Task 1); from `app.js` (classic script, so its top-level names are global): `$`, `el(tag, text, className)`, `row(cells)`, `onSubmit(form, handler)`, `api(path, body)`.
- Produces: global `loadTables()`, called by `app.js`'s `refresh()`.

- [ ] **Step 1: HTML.** In `index.html`, after `<script src="app.js" defer></script>` add `<script src="db.js" defer></script>`. Between `<button id="more-logs" …>` and `<h2>Account</h2>` insert:

```html
    <h2>Database</h2>
    <div id="db-tables" class="search"></div>
    <form id="db-form" class="search">
      <textarea name="sql" rows="4" spellcheck="false" aria-label="SQL" placeholder="SELECT … (Ctrl+Enter to run)"></textarea>
      <button>Run</button>
      <p class="error" role="alert"></p>
    </form>
    <p id="db-status" role="status"></p>
    <div class="scroll">
      <table id="db-result"><thead></thead><tbody></tbody></table>
    </div>
    <div class="search">
      <button id="db-prev" type="button" hidden>Prev</button>
      <button id="db-next" type="button" hidden>Next</button>
    </div>
```

- [ ] **Step 2: `public/admin/db.js`:**

```js
// Database section: lists the tables and runs admin-written SQL through POST /admin/api/sql.
// Uses $, el, row, onSubmit and api from app.js. Values go in through textContent only, never innerHTML.
const DB_PAGE = 50;
// "_" is a LIKE wildcard: escaped, so only sqlite_* and _cf_* (D1 internals) are hidden.
const LIST_TABLES =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name";
const dbForm = $("#db-form");
const dbPrev = $("#db-prev");
const dbNext = $("#db-next");
let dbPage = null; // { table, offset } while a table is browsed

const quoteName = (name) => `"${name.replaceAll('"', '""')}"`;
const showCell = (v) => (v === null ? "NULL" : typeof v === "object" ? JSON.stringify(v) : v);

function renderResult({ columns, rows, truncated, meta }, shown = rows) {
  const head = el("tr");
  head.append(...columns.map((c) => el("th", c)));
  $("#db-result thead").replaceChildren(head);
  $("#db-result tbody").replaceChildren(
    ...shown.map((r) => {
      const tr = row(columns.map((c) => showCell(r[c])));
      for (const td of tr.children) td.title = td.textContent;
      return tr;
    }),
  );
  const parts = [`${shown.length} rows`, `${meta.changes} changes`, `${meta.duration} ms`];
  if (truncated) parts.push("showing the first 1000");
  $("#db-status").textContent = parts.join(" · ");
}

async function loadTables() {
  const { rows } = await api("sql", { sql: LIST_TABLES });
  $("#db-tables").replaceChildren(
    ...rows.map(({ name }) => {
      const button = el("button", name);
      button.type = "button";
      button.addEventListener("click", () => browse(name, 0));
      return button;
    }),
  );
}

async function browse(table, offset) {
  const sql = `SELECT * FROM ${quoteName(table)} LIMIT ${DB_PAGE + 1} OFFSET ${offset}`;
  dbForm.elements.sql.value = sql;
  dbForm.querySelector(".error").textContent = "";
  try {
    const data = await api("sql", { sql });
    dbPage = { table, offset };
    renderResult(data, data.rows.slice(0, DB_PAGE));
    dbPrev.hidden = offset === 0;
    dbNext.hidden = data.rows.length <= DB_PAGE;
  } catch (e) {
    dbForm.querySelector(".error").textContent = e.message;
  }
}

onSubmit(dbForm, async ({ sql }) => {
  dbPage = null;
  dbPrev.hidden = dbNext.hidden = true;
  $("#db-status").textContent = "";
  renderResult(await api("sql", { sql }));
  await loadTables(); // a CREATE or DROP shows at once
});
dbForm.elements.sql.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) dbForm.requestSubmit();
});
dbPrev.addEventListener("click", () => browse(dbPage.table, dbPage.offset - DB_PAGE));
dbNext.addEventListener("click", () => browse(dbPage.table, dbPage.offset + DB_PAGE));
```

- [ ] **Step 3: `app.js`.** In `refresh()`, after `await loadLogs(true);` add `await loadTables();`. (`db.js` has run by then: `refresh` first runs after `api("me")` resolves.)
- [ ] **Step 4: `style.css`,** append:

```css
#db-form textarea { flex: 1 1 100%; font: 13px/1.4 ui-monospace, monospace; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
#db-status { color: var(--muted); margin: 8px 0 0; }
#db-result td { max-width: 40ch; overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 5: Checks.** `node --check public/admin/db.js`, `node --check public/admin/app.js`, `npm test`, `npm run typecheck` → all pass.
- [ ] **Step 6: Headless check.** `npm run db:migrate:local`, start `npm run dev`, log in at `http://localhost:8787/admin/` in headless Chrome (CDP, as in the earlier plans' checks) and assert:
  - the table buttons include `clients`, `templates`, `app_logs`, and none starts with `_cf_` or `sqlite_`;
  - Run `CREATE TABLE "we""ird" (v TEXT); CREATE TABLE xcfy (v TEXT)` → buttons `we"ird` and `xcfy` appear without a reload (Review Focus 5); clicking `we"ird` shows 0 rows and no error;
  - Run `INSERT INTO xcfy VALUES ('<script>alert(1)</script>')`, then click `xcfy`: the cell's text is that string and `#db-result script` matches 0 elements (Review Focus 4);
  - Run `CREATE TABLE nums AS WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120) SELECT i FROM n`, click `nums` → 50 rows, Prev hidden, Next shown; Next twice → 20 rows, Next hidden, Prev shown;
  - Run `SELEC 1` → the form's alert shows a message containing `syntax error`.

  Then Run `DROP TABLE "we""ird"; DROP TABLE xcfy; DROP TABLE nums` to clean the local DB, and stop every `wrangler`/`workerd` process (the handoff's PowerShell one-liner: `TaskStop` alone leaves them running).
- [ ] **Step 7: Commit.** `git add public/admin`, message `feat(admin): Database section`.

### Task 3: Docs

**Files:** `docs/admin-dashboard.md`, `CLAUDE.md`.

- [ ] **Step 1: `docs/admin-dashboard.md`,** insert before `## Security`:

```md
## Database

The **Database** section browses and changes the D1 database directly. Click a table to see it 50 rows at a time, or type any SQL statement and press **Run** (or Ctrl+Enter).

- **Writes are immediate and unrestricted.** `UPDATE`, `DELETE`, `DROP` run as typed, with no confirmation and no undo; the admin session is the only gate. You can also lock yourself out by changing `admin_user` or `admin_sessions`.
- **At most 1000 rows** come back; D1 still reads the whole result, so add `LIMIT` to large queries.
- **Several statements** separated by `;` all run, but only the last one's rows are shown.
- **Duplicate column names** (`SELECT a.id, b.id …`) collapse into one: alias them (`b.id AS b_id`).
- The SQL text and D1's error messages are never written to the logs: a failed statement is logged only as `sql_error`.
```

  In "What it shows", change "Everything comes from the delivery log" to "The cards, chart, errors and deliveries come from the delivery log". Keep the file under 200 lines.
- [ ] **Step 2: `CLAUDE.md`,** "Admin" paragraph: replace "Stats and search only read `email_deliveries`; see `docs/admin-dashboard.md`." with "Stats and search only read `email_deliveries`; the Database section (`POST /admin/api/sql`) runs any SQL on D1. See `docs/admin-dashboard.md`."
- [ ] **Step 3: Checks.** `npm run docs:build` → no dead links. Each touched `.md` under 200 lines.
- [ ] **Step 4: Commit.** `git add docs/admin-dashboard.md CLAUDE.md`, message `docs: admin DB editor`.

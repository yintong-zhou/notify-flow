# Admin Dashboard Plan — Part 5: Task 2 code, Task 3 UI

[← Part 4](2026-10-15-admin-dashboard-part4.md) · [Part 6: app.js →](2026-10-15-admin-dashboard-part6.md)

## `src/admin/stats.ts`

```ts
import { invalid } from "../security/validation";
import { ABANDONED_AFTER_S } from "../services/email-service";
import type { DeliveryStatus } from "../types";

const STATUSES: DeliveryStatus[] = ["accepted", "queued", "processing", "retrying", "submitted", "failed"];
// window → [span, bucket] in seconds; buckets are UTC hours or days.
const WINDOWS: Record<string, [number, number]> = { "24h": [86400, 3600], "7d": [7 * 86400, 86400], "30d": [30 * 86400, 86400] };
const FILTERS = ["id", "recipient", "client_id", "template", "status", "error_code"] as const;
const PAGE = 50;
const CURSOR_RE = /^(\d+):(msg_[0-9a-f-]{36})$/;

export async function stats(req: Request, env: Env): Promise<Response> {
  const window = new URL(req.url).searchParams.get("window") ?? "24h";
  if (!Object.hasOwn(WINDOWS, window)) invalid("window must be one of 24h, 7d, 30d");
  const [span, bucket] = WINDOWS[window];
  // ponytail: GROUP BY over up to 30 days of raw rows. Past a few 100k deliveries a month, add a daily aggregate table the cron fills.
  const [byStatus, errors, series] = await env.DB.batch([
    env.DB.prepare(
      `SELECT status, COUNT(*) AS count,
         SUM(status = 'processing' AND COALESCE(claimed_at, created_at) < unixepoch() - ?) AS stalled
       FROM email_deliveries WHERE created_at >= unixepoch() - ? GROUP BY status`,
    ).bind(ABANDONED_AFTER_S, span),
    env.DB.prepare(
      `SELECT d.error_code, d.client_id, c.name AS client_name, d.template, COUNT(*) AS count
       FROM email_deliveries d JOIN clients c ON c.id = d.client_id
       WHERE d.created_at >= unixepoch() - ? AND d.error_code IS NOT NULL
       GROUP BY d.error_code, d.client_id, d.template ORDER BY count DESC LIMIT 20`,
    ).bind(span),
    env.DB.prepare(
      `SELECT created_at - created_at % ? AS bucket, status, COUNT(*) AS count
       FROM email_deliveries WHERE created_at >= unixepoch() - ? GROUP BY bucket, status ORDER BY bucket`,
    ).bind(bucket, span),
  ]);
  const byStatusCounts: Record<string, number> = Object.fromEntries([...STATUSES, "stalled"].map((s) => [s, 0]));
  for (const row of byStatus.results as { status: string; count: number; stalled: number }[]) {
    byStatusCounts[row.status] = row.count;
    byStatusCounts.stalled += row.stalled;
  }
  return Response.json({ window, by_status: byStatusCounts, errors: errors.results, series: series.results });
}

export async function deliveries(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const where: string[] = [];
  const binds: (string | number)[] = [];
  for (const field of FILTERS) {
    const value = params.get(field);
    if (!value) continue;
    if (field === "status" && !(STATUSES as string[]).includes(value)) invalid(`status must be one of ${STATUSES.join(", ")}`);
    where.push(`d.${field} = ?`); // field comes from FILTERS, never from the request
    binds.push(field === "recipient" ? value.toLowerCase() : value);
  }
  const before = params.get("before");
  if (before) {
    const cursor = CURSOR_RE.exec(before);
    if (!cursor) invalid("before must be a cursor returned as next");
    where.push("(d.created_at < ? OR (d.created_at = ? AND d.id < ?))");
    binds.push(Number(cursor[1]), Number(cursor[1]), cursor[2]);
  }
  const { results } = await env.DB.prepare(
    `SELECT d.*, c.name AS client_name FROM email_deliveries d JOIN clients c ON c.id = d.client_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
  )
    .bind(...binds, PAGE + 1)
    .all<{ id: string; created_at: number }>();
  const page = results.slice(0, PAGE);
  const last = page.at(-1);
  return Response.json({ deliveries: page, next: results.length > PAGE && last ? `${last.created_at}:${last.id}` : null });
}
```

---

### Task 3: Dashboard page

**Files:**
- Create: `public/admin/index.html` (below), `public/admin/app.js` (Part 6), `public/admin/style.css` (Part 7)
- Modify: `wrangler.jsonc`, `wrangler.jsonc.example`

**Interfaces:**
- Consumes: the `/admin/api/*` routes from Tasks 1 and 2, with these exact JSON shapes:
  - `me` returns `{registered, logged_in, email?}`;
  - `stats` returns `{window, by_status, errors[], series[]}`;
  - `deliveries` returns `{deliveries[], next}`;
  - errors are `{error: {code, message}}`.
- Produces: nothing consumed by code.

- [ ] **Step 1: Assets config.** In both wrangler files, after `compatibility_date`, add:
  ```jsonc
  // Admin dashboard pages (public/admin/), served without running the Worker.
  // /v1/*, /health and /admin/api/* match no file, so they still reach the Worker.
  "assets": { "directory": "./public" },
  ```
- [ ] **Step 2:** Create `index.html` below, `app.js` from [Part 6](2026-10-15-admin-dashboard-part6.md) and `style.css` from [Part 7](2026-10-15-admin-dashboard-part7.md).
- [ ] **Step 3: Checks.** Run `npm test` and `npm run typecheck`. Expected: both pass, which means the assets config does not break the test pool.
- [ ] **Step 4: Manual check.** Follow the steps in [Part 7](2026-10-15-admin-dashboard-part7.md).
- [ ] **Step 5: Commit.** Run `git add public wrangler.jsonc.example`, then `git commit -m "feat(admin): dashboard page"`.

## `public/admin/index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>notify-flow admin</title>
  <link rel="stylesheet" href="style.css">
  <script src="app.js" defer></script>
</head>
<body>
<main>
  <section id="setup" hidden>
    <h1>First-time setup</h1>
    <form id="setup-form" class="box">
      <label>Setup token <input name="setup_token" type="password" required autocomplete="off"></label>
      <label>Email <input name="email" type="email" required autocomplete="username"></label>
      <label>Password (12+ characters) <input name="password" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></label>
      <button>Create admin</button>
      <p class="error" role="alert"></p>
    </form>
  </section>

  <section id="login" hidden>
    <h1>notify-flow admin</h1>
    <form id="login-form" class="box">
      <label>Email <input name="email" type="email" required autocomplete="username"></label>
      <label>Password <input name="password" type="password" required autocomplete="current-password"></label>
      <button>Log in</button>
      <p class="error" role="alert"></p>
    </form>
  </section>

  <section id="dashboard" hidden>
    <header>
      <h1>notify-flow</h1>
      <select id="window" aria-label="Time window">
        <option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option>
      </select>
      <button id="refresh" type="button">Refresh</button>
      <button id="logout" type="button">Log out</button>
    </header>
    <p id="dash-error" class="error" role="alert"></p>
    <div id="cards" class="cards"></div>

    <h2>Over time</h2>
    <svg id="chart" role="img" aria-label="Deliveries over time by status"></svg>
    <div id="legend" class="legend"></div>

    <h2>Errors</h2>
    <div class="scroll">
      <table id="errors"><thead><tr><th>Code</th><th>Client</th><th>Template</th><th>Count</th></tr></thead><tbody></tbody></table>
    </div>

    <h2>Deliveries</h2>
    <form id="search" class="search">
      <input name="id" placeholder="msg_…" aria-label="Message id">
      <input name="recipient" placeholder="Recipient" aria-label="Recipient">
      <input name="client_id" placeholder="Client id" aria-label="Client id">
      <input name="template" placeholder="Template" aria-label="Template">
      <select name="status" aria-label="Status">
        <option value="">Any status</option><option>submitted</option><option>failed</option><option>processing</option>
        <option>queued</option><option>retrying</option><option>accepted</option>
      </select>
      <input name="error_code" placeholder="Error code" aria-label="Error code">
      <button>Search</button>
      <p class="error" role="alert"></p>
    </form>
    <div class="scroll">
      <table id="deliveries"><thead><tr><th>Created</th><th>Id</th><th>Client</th><th>Template</th><th>Recipient</th>
        <th>Status</th><th>Attempts</th><th>Error</th><th>Sent</th></tr></thead><tbody></tbody></table>
    </div>
    <button id="more" type="button" hidden>Load more</button>

    <h2>Account</h2>
    <form id="password-form" class="box">
      <label>Current password <input name="current" type="password" required autocomplete="current-password"></label>
      <label>New password (12+ characters) <input name="new" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></label>
      <button>Change password</button>
      <p class="error" role="alert"></p>
      <p class="ok" role="status"></p>
    </form>
  </section>
</main>
</body>
</html>
```

## `public/admin/style.css`

The code is in [Part 7](2026-10-15-admin-dashboard-part7.md#publicadminstylecss).

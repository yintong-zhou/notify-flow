# Admin log viewer — Design

Date: 2026-10-15
Builds on: [Admin dashboard](2026-10-15-admin-dashboard-design.md) (sub-project 2 of its roadmap)

## Goal

**A trail of what goes wrong:** the operator opens the dashboard and sees errors, warnings and info events that `email_deliveries` does not record. For example rejected API keys, rate limits, malformed calls, internal errors, and every failed SMTP attempt before a retry.

Success:
- Every server error, failed SMTP attempt, security rejection and client error is stored as one `app_logs` row and shown in a **Logs** section with filters.
- From a delivery, one click shows its log events. From an IP, one click shows everything that IP triggered.
- Anonymous traffic cannot flood D1: at most 30 request-originated warn/info rows per minute per IP.
- No log row ever holds variables, content, tokens, credentials, query strings or SMTP reply text.

## Decisions

- **D1 table `app_logs`:** everything lives in the dashboard, it is testable like the rest, and the 30-day cleanup reuses the cron.
- **One place for request errors:** `errorResponse` in `index.ts` logs every error response, so routes need no logging code.
- **Rate limiter for logs:** `LOG_RATE_LIMITER` (per IP, 30 per 60 s) gates request-originated warn and info. Errors and SMTP attempts are never gated, because the caller cannot trigger them at will.
- **Full IP, kept 30 days:** an IP lets the operator spot one source or write a WAF rule. The docs state the retention.
- **Rejected:**
  - Workers Logs read through the Cloudflare telemetry API: needs an account API token secret and has short retention;
  - Cloudflare's dashboard alone: the logs would live outside this dashboard;
  - per-minute aggregation rows: they bound the row count but not the writes.

## Data (`migrations/0007_app_logs.sql`)

```sql
CREATE TABLE app_logs (
  id         INTEGER PRIMARY KEY,               -- rowid: insertion order, used as the cursor
  created_at INTEGER NOT NULL,                  -- unix seconds
  level      TEXT NOT NULL CHECK (level IN ('error', 'warn', 'info')),
  code       TEXT NOT NULL,                     -- error code, e.g. smtp_failed, unauthorized, smtp_attempt_failed
  status     INTEGER,                           -- HTTP status; NULL outside a request
  method     TEXT,
  path       TEXT,                              -- pathname only, never the query string; at most 128 characters
  client_id  TEXT,                              -- when already authenticated
  message_id TEXT,                              -- msg_… when the event concerns a delivery
  ip         TEXT,                              -- CF-Connecting-IP
  detail     TEXT                               -- fixed vocabulary only, e.g. "smtp_timeout attempt 2/3"
);
CREATE INDEX idx_logs_created ON app_logs (created_at);
```

## Logger (`src/services/logger.ts`)

```ts
export interface LogEvent {
  level: "error" | "warn" | "info";
  code: string;
  status?: number; method?: string; path?: string;
  client_id?: string; message_id?: string; ip?: string; detail?: string;
}
export async function log(db: D1Database, event: LogEvent): Promise<void>;
```

- It inserts one row with `created_at = unixepoch()`, truncates `path` to 128 characters, and prints the event as one JSON line with `console.log`, so `wrangler tail` shows it too.
- **It never throws.** A failed insert is reported with `console.error(JSON.stringify({ error_code: "log_write_failed" }))` and then ignored: logging must never fail a send or change a response.
- It takes `db` rather than `env`, so tests can pass a failing D1.

## What is logged, and where

| Event | Level | `code` | Where |
|---|---|---|---|
| Error response with status ≥ 500 | error | the response code (`smtp_failed`, `smtp_misconfigured`, `queue_unavailable`, `internal_error`) | `errorResponse` |
| 401, 403, 429 | warn | the response code | `errorResponse`, through the limiter |
| Other 4xx | info | the response code | `errorResponse`, through the limiter |
| A transient SMTP failure that will be retried (sync or queue) | warn | `smtp_attempt_failed` | retry branch of `sendTemplatedEmail` and of the queue consumer |
| A queued send that fails for good | error | its error code (`smtp_rejected`, `template_not_found`, …) | consumer, replacing its `console.error` |

- **Request fields:**
  - `errorResponse` receives the request, the client id when authentication has already passed, and `ctx`;
  - it fills `status`, `method`, `path` (`new URL(req.url).pathname`), `ip` (the `CF-Connecting-IP` header) and `message_id` (from `HttpError.extra.id` when present);
  - it writes inside `ctx.waitUntil` when `ctx` exists, so the response does not wait.
- **Not logged:** a 404 whose path starts with neither `/v1/` nor `/admin/api/`. That is scanner noise.
- **Limiter:**
  - before a warn or info from `errorResponse`, `LOG_RATE_LIMITER.limit({ key: ip })` runs; when it returns `success: false`, the event is dropped;
  - without a `CF-Connecting-IP` header (tests, local dev), nothing is gated.
- **SMTP attempts:**
  - `detail` is `"<SmtpError.code> attempt <n>/<max>"`, where max is 3 for sync sends and 5 for queued sends;
  - `message_id` and `client_id` are set;
  - `SmtpError.message` is never logged;
  - the sync path awaits the write, which costs a few ms next to its backoff; the consumer awaits it too.
- **The existing `console.error` lines:**
  - in `email-service.ts`, both go: the 502 `smtp_failed` and the 503 `queue_unavailable` reach `errorResponse` with their `id`;
  - in `queue-consumer.ts`, it becomes the error row above;
  - the `internal_error` log in `errorResponse` becomes a row too.
- **Cleanup:** `purgeLogs(db)` deletes rows older than 30 days in batches of 1000, like `purgeDeliveries`. The daily cron runs it.

## Viewer API

`GET /admin/api/logs?level=&code=&client_id=&ip=&message_id=&before=` (wrapped in `withSession`)

- Every filter is optional and uses an exact match. `level` must be `error`, `warn` or `info`.
- The order is `id DESC`, 50 rows per page. `before=<id>` is the cursor (a positive integer), and the response is `{logs, next}`, where `next` is the last row's `id` or `null`.
- Each row returns every `app_logs` column plus `client_name` (`LEFT JOIN clients`: a 401 has no client).
- A bad `level` or `before` answers `400 validation_error`.
- Like every `/admin/api` response, it is `no-store`.

## UI

- A **Logs** section after Deliveries, with these filters: level (any / error / warn / info), code, client id, IP and message id.
- The table shows time, level, code, status, method and path, client, message id, IP and detail, with "Load more" (disabled while loading).
- Level colors: error uses the existing `--bad`, warn a new `--warn`.
- **Cross-links:**
  - clicking a message id in the Deliveries table resets the Logs filters, sets `message_id`, loads, and scrolls to Logs;
  - clicking an IP in the Logs table filters by that IP.
- Every value goes in through `textContent`. `path` is caller-controlled.
- Opening the dashboard and Refresh both load the first log page.

## Config

- In both wrangler files, add `{ "name": "LOG_RATE_LIMITER", "namespace_id": "1004", "simple": { "limit": 30, "period": 60 } }`.
- No new secret.

## Testing

- **Logger:** writes the row; truncates `path`; a D1 whose `prepare` throws does not make `log` throw.
- **Levels via `handle()`:**
  - a 502 `smtp_failed` gives error with its `message_id`;
  - 401, 403 and 429 give warn;
  - 400 and 404 on `/v1/...` give info;
  - a 404 on `/wp-login.php` gives no row;
  - the query string never appears in `path`.
- **Limiter:** with `CF-Connecting-IP`, 31 bad-key calls give 30 warn rows, and an error from the same IP is still written.
- **SMTP:**
  - a sync send failing twice with a transient error, then succeeding, gives two `smtp_attempt_failed` rows with `attempt 1/3` and `attempt 2/3`;
  - the injected error's message text appears in no row;
  - a queued send failing permanently gives one error row with its code and `message_id`.
- **Cleanup:** rows older than 30 days go, newer ones stay.
- **API:** each filter; the cursor (page 2 does not repeat, the last page has `next: null`); 400 on a bad `level` or `before`; 401 without a session; `no-store`.
- **UI:** headless Chrome with seeded rows checks the message id → Logs link, the IP filter, and that a `<script>` path renders as text.

## Docs

- `docs/admin-dashboard.md` gets a "Logs" section: which events are logged, their levels, the 30-per-minute limit per IP, the full IP kept 30 days, and what is never stored.
- `CLAUDE.md`:
  - the logging constraint becomes "events go to `app_logs` through `log()`, with the fields above only";
  - add an Architecture line for `logger.ts`.

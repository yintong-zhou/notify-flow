# Admin Log Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** log errors, failed SMTP attempts, security rejections and client errors to a D1 `app_logs` table, and show them in a filterable Logs section of the admin dashboard.

**Architecture:**
- `src/services/logger.ts` owns writing. `log()` never throws; `logRequestError()` maps an `HttpError` to a level and gates warn/info through `LOG_RATE_LIMITER`.
- `index.ts`'s `errorResponse` becomes the single point for request errors.
- The retry branches of the sync send and of the queue consumer log each failed attempt.
- `/admin/api/logs` reads the table, and the dashboard pages it.

**Tech Stack:** TypeScript on Cloudflare Workers, D1, Rate Limiting bindings, vanilla JS, vitest in workerd. No runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-10-15-admin-logs-design.md`](../specs/2026-10-15-admin-logs-design.md)

**Branch:** `feat/admin-logs`, already created on top of `feat/admin-dashboard`.

**Parts:**
1. This file: constraints, review focus, file map, Task 1.
2. [Part 2](2026-10-15-admin-logs-part2.md): Task 1 tests, Task 2 (SMTP attempts), Task 3 steps.
3. [Part 3](2026-10-15-admin-logs-part3.md): Task 3 test and code, Task 4 HTML and JS.
4. [Part 4](2026-10-15-admin-logs-part4.md): Task 4 CSS and headless check, Task 5 (docs).

## Global Constraints

- **No runtime dependencies.** `vi.mock` does not work: inject through parameters or `{ ...env, X: fake }`.
- **D1 state is shared between the tests of a file.** Every new test file starts with `beforeEach` → `DELETE FROM app_logs`. Each limiter test uses its own IP.
- **Never in a log:**
  - variables, rendered content, tokens, credentials;
  - the query string;
  - `SmtpError.message` or `e.message` of an unexpected error.

  `detail` holds only `"<SmtpError.code> attempt <n>/<max>"`.
- **`log()` and `logRequestError()` never throw**, and they never change a response's status or body.
- **Exact values:**
  - levels are `error`, `warn` and `info`;
  - `LOG_RATE_LIMITER` uses namespace `"1004"`, 30 per 60 s per IP;
  - `path` is cut to 128 characters;
  - retention is 30 days, purged in batches of 1000;
  - 50 rows per API page;
  - max attempts are 3 for sync sends and 5 for queued sends.
- **Error response bodies stay byte-identical**, so every existing test passes unchanged.
- **`wrangler.jsonc` is git-ignored:** edit it and `.example`, and commit only `.example`.
- **Markdown under 200 lines.**
- **Commands:** `npx vitest run <file>`, `npm test`, `npm run typecheck`.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A broken limiter or D1 while answering an error** still returns the same error response. Covered by a Task 1 test with a throwing `LOG_RATE_LIMITER`.
2. **An unexpected (non-`HttpError`) exception** logs `internal_error` with no message text, and the body stays `{"error":{"code":"internal_error","message":"Internal error"}}`. This is checked by reading the code in Task 1, Step 5.
3. **A caller-chosen path with `<script>`** renders as text in the Logs table. Covered by the Task 4 headless check.
4. **A 401 on `/admin/api/*` (wrong admin password)** is logged as warn with no client. Covered by a Task 3 test, which asserts the row its own 401 creates.
5. **A queued send whose log write fails** still acks or retries as before. `log()` swallows the error; covered by the existing "D1 failing after the claim" tests staying green.

## File map

| File | Task |
|---|---|
| `migrations/0007_app_logs.sql`, `src/services/logger.ts`, `test/logs.test.ts` | 1 (logs.test.ts grows in 2) |
| `src/index.ts`, `wrangler.jsonc(.example)` | 1 |
| `src/services/email-service.ts`, `src/services/queue-consumer.ts`, `test/async-send.test.ts` | 2 |
| `src/admin/stats.ts`, `src/admin/routes.ts`, `test/admin-logs.test.ts` | 3 |
| `public/admin/index.html`, `app.js`, `style.css` | 4 |
| `docs/admin-dashboard.md`, `CLAUDE.md` | 5 |

---

### Task 1: Logger and request-error logging

**Interfaces:**
- **Produces** (`src/services/logger.ts`):
  - `interface LogEvent`;
  - `log(db: D1Database, event: LogEvent): Promise<void>`;
  - `logRequestError(env: Env, req: Request, error: HttpError, clientId?: string): Promise<void>`;
  - `purgeLogs(db: D1Database): Promise<void>`.
- **Consumes:** `HttpError` from `src/types`.

- [ ] **Step 1: Config and migration.**
  - Add `LOG_RATE_LIMITER` to `ratelimits` in both wrangler files, with the comment `// Per-IP cap on request warn/info log rows: anonymous traffic cannot flood app_logs.`
  - Create `migrations/0007_app_logs.sql` with the spec's SQL, verbatim.
  - Run `npm run typecheck`. Expected: passes, and `LOG_RATE_LIMITER: RateLimit` is in `worker-configuration.d.ts`.
- [ ] **Step 2: Failing tests.** Create `test/logs.test.ts` with the code in [Part 2](2026-10-15-admin-logs-part2.md#testlogstestts-task-1). Run `npx vitest run test/logs.test.ts`. Expected: FAIL, because `../src/services/logger` cannot be resolved.
- [ ] **Step 3: Logger.** Create `src/services/logger.ts`:

```ts
import { HttpError } from "../types";

export interface LogEvent {
  level: "error" | "warn" | "info";
  code: string;
  status?: number;
  method?: string;
  path?: string;
  client_id?: string;
  message_id?: string;
  ip?: string;
  detail?: string;
}

const RETENTION_S = 30 * 24 * 3600;
const PURGE_BATCH = 1000;

/** Writes one app_logs row. Never throws: logging must not fail a send or change a response. */
export async function log(db: D1Database, event: LogEvent): Promise<void> {
  const e = { ...event, path: event.path?.slice(0, 128) };
  console.log(JSON.stringify(e));
  try {
    await db
      .prepare(
        `INSERT INTO app_logs (created_at, level, code, status, method, path, client_id, message_id, ip, detail)
         VALUES (unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(e.level, e.code, e.status ?? null, e.method ?? null, e.path ?? null, e.client_id ?? null, e.message_id ?? null, e.ip ?? null, e.detail ?? null)
      .run();
  } catch {
    console.error(JSON.stringify({ error_code: "log_write_failed" }));
  }
}

/** Logs an error response: 5xx error, 401/403/429 warn, other 4xx info. Warn and info are capped per IP. */
export async function logRequestError(env: Env, req: Request, error: HttpError, clientId?: string): Promise<void> {
  try {
    const path = new URL(req.url).pathname;
    // Scanner noise: unknown paths outside the API.
    if (error.status === 404 && !path.startsWith("/v1/") && !path.startsWith("/admin/api/")) return;
    const level = error.status >= 500 ? "error" : [401, 403, 429].includes(error.status) ? "warn" : "info";
    const ip = req.headers.get("CF-Connecting-IP") ?? undefined;
    if (level !== "error" && ip && !(await env.LOG_RATE_LIMITER.limit({ key: ip })).success) return;
    const messageId = typeof error.extra.id === "string" ? error.extra.id : undefined;
    await log(env.DB, { level, code: error.code, status: error.status, method: req.method, path, client_id: clientId, message_id: messageId, ip });
  } catch {
    console.error(JSON.stringify({ error_code: "log_write_failed" }));
  }
}

/** Deletes rows older than 30 days, in batches so one statement never holds the write lock for long. */
export async function purgeLogs(db: D1Database): Promise<void> {
  for (;;) {
    const { meta } = await db
      .prepare("DELETE FROM app_logs WHERE id IN (SELECT id FROM app_logs WHERE created_at < unixepoch() - ? LIMIT ?)")
      .bind(RETENTION_S, PURGE_BATCH)
      .run();
    if (meta.changes < PURGE_BATCH) return;
  }
}
```

- [ ] **Step 4: `src/index.ts`.**
  - Add the import `import { logRequestError, purgeLogs } from "./services/logger";`.
  - In `handle`, declare `let clientId: string | undefined;` before `try`, and change `const clientId = await authenticate(req, env);` to `clientId = await authenticate(req, env);`.
  - Change the `catch` to `return await errorResponse(req, env, e, clientId, ctx);`.
  - Replace `errorResponse` with:

```ts
async function errorResponse(req: Request, env: Env, e: unknown, clientId?: string, ctx?: ExecutionContext): Promise<Response> {
  // No e.message for unexpected errors: it could carry request data, and logs must never hold it.
  const error = e instanceof HttpError ? e : new HttpError(500, "internal_error", "Internal error");
  const logged = logRequestError(env, req, error, clientId);
  if (ctx) ctx.waitUntil(logged);
  else await logged;
  return Response.json({ error: { code: error.code, message: error.message }, ...error.extra }, { status: error.status });
}
```

  - In `scheduled`, add `purgeLogs(env.DB)` to the `Promise.all`.
- [ ] **Step 5: Run.**
  - Run `npx vitest run test/logs.test.ts`. Expected: every Task 1 test passes.
  - Run `npm test` and `npm run typecheck`. Expected: all green.
  - Read the new `errorResponse` and check Review Focus 2.
- [ ] **Step 6: Commit.** Run `git add migrations src test wrangler.jsonc.example`, then `git commit -m "feat(logs): app_logs table, logger and request-error logging"`.

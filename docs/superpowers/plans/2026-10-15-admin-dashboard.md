# Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a `/admin` page where one admin, who registers once with a setup token, sees delivery stats, searches deliveries and changes the password.

**Architecture:** static HTML/CSS/JS in `public/admin/`, served by Workers static assets. A JSON API at `/admin/api/*` in the same Worker (`src/admin/`) authenticates with a D1-backed session cookie, completely separate from API-key auth. Stats and search only read `email_deliveries`.

**Tech Stack:** TypeScript on Cloudflare Workers, D1, Rate Limiting bindings, WebCrypto (PBKDF2, `timingSafeEqual`), static assets, vanilla JS and inline SVG, and vitest in workerd via `@cloudflare/vitest-plugin`. No runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-10-15-admin-dashboard-design.md`](../specs/2026-10-15-admin-dashboard-design.md)

**Branch:** `feat/admin-dashboard`, already created. Commit there.

**Parts:**
1. This file: constraints, review focus, file map, Task 1 steps.
2. [Part 2](2026-10-15-admin-dashboard-part2.md): Task 1 tests.
3. [Part 3](2026-10-15-admin-dashboard-part3.md): Task 1 code (`auth.ts`, `routes.ts`).
4. [Part 4](2026-10-15-admin-dashboard-part4.md): Task 1 code (`rate-limit.ts`, `index.ts`), Task 2 steps and tests.
5. [Part 5](2026-10-15-admin-dashboard-part5.md): Task 2 code (`stats.ts`), Task 3 steps and HTML.
6. [Part 6](2026-10-15-admin-dashboard-part6.md): Task 3 `app.js`.
7. [Part 7](2026-10-15-admin-dashboard-part7.md): Task 3 CSS and manual check, Task 4 (docs).

## Global Constraints

- **No runtime dependencies.** Do not add packages. No chart library and no frontend framework.
- **`vi.mock` does not work in the Workers pool.** Inject through parameters or `env` (for example `{ ...env, ADMIN_SETUP_TOKEN: "" }`).
- **Storage is isolated per test** (`@cloudflare/vitest-plugin`), so set up state in `beforeEach`, not `beforeAll`.
- **Never log or store secrets:**
  - logs and rows never contain the admin email, a password, the setup token or a session token;
  - only the PBKDF2 hash and the session token's SHA-256 are stored;
  - unexpected errors still log only `{error_code: "internal_error"}`.
- **Exact values from the spec:**
  - PBKDF2-SHA256 with 100 000 iterations and a 16-byte salt; stored as `pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>`;
  - password length 12 to 256;
  - cookie `nf_admin=<64 hex>; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=604800`;
  - `ADMIN_RATE_LIMITER` uses `namespace_id` `"1003"`, 10 requests per 60 s per IP, on `setup`, `login` and `password`;
  - windows `24h`, `7d` and `30d`, with hour buckets for `24h` and UTC-day buckets otherwise;
  - top 20 errors, and 50 rows per search page.
- **Status names** are `accepted`, `queued`, `processing`, `retrying`, `submitted`, `failed` and the derived `stalled`. Never `delivered`.
- **UI safety:** caller-controlled values go into the DOM with `textContent` only, never with `innerHTML`.
- **`wrangler.jsonc` is git-ignored.** Edit both it and `wrangler.jsonc.example`, and commit only the example.
- **Markdown under 200 lines.** Every `.md` file stays under 200 lines.
- **Commands:**
  - `npx vitest run <file>` and `npx vitest run -t "<name>"` for single tests;
  - `npm test` for the full suite;
  - `npm run typecheck`, which regenerates `worker-configuration.d.ts` from `wrangler.jsonc` and then runs `tsc`.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A wrong current password on the password form must not log the user out.** It returns `401 invalid_credentials`, and `app.js` redirects only on `unauthorized`. Covered by the Task 3 manual check, step 6.
2. **Two concurrent first setups:** exactly one gets `201`, the other `409`. Covered by a Task 1 test.
3. **A cookie header with other cookies** (`theme=dark; nf_admin=…`) is still recognized. Covered by a Task 1 test.
4. **Bad query strings** (`window=1y`, `status=delivered`, `before=abc`) answer `400`, never `500`. Covered by Task 2 tests.
5. **An empty database** shows zeros and empty lists, not errors or `null`. Covered by a Task 2 test, and by the Task 3 manual check on a fresh local DB.

## File map

| File | Task | Responsibility |
|---|---|---|
| `migrations/0006_admin.sql` | 1 | `admin_user`, `admin_sessions` |
| `src/admin/auth.ts` | 1 | password hashing, setup-token compare, sessions |
| `src/admin/routes.ts` | 1, 2 | `/admin/api/*` dispatch and account routes |
| `src/admin/stats.ts` | 2 | `stats` and `deliveries` handlers |
| `src/index.ts` | 1 | route `/admin/api/`, purge sessions in the cron |
| `src/security/rate-limit.ts` | 1 | `checkAdminLimit` |
| `src/security/validation.ts` | 1 | export `EMAIL_RE` |
| `src/services/email-service.ts` | 2 | export `ABANDONED_AFTER_S` |
| `wrangler.jsonc(.example)`, `vitest.config.ts`, `.dev.vars.example` | 1, 3 | limiter, secret, assets |
| `test/helpers.ts` | 1 | `adminCall`, `sessionCookie`, `setupAdmin`, `SETUP_TOKEN` |
| `test/admin.test.ts` | 1 | auth and account tests |
| `test/admin-stats.test.ts` | 2 | stats and search tests |
| `public/admin/index.html`, `style.css`, `app.js` | 3 | the dashboard page |
| `docs/admin-dashboard.md`, `docs/.vitepress/config.mts`, `CLAUDE.md`, `README.md` | 4 | docs |

---

### Task 1: Admin auth and account API

**Files:**
- Create: `migrations/0006_admin.sql`, `src/admin/auth.ts`, `src/admin/routes.ts`, `test/admin.test.ts`
- Modify: `src/index.ts`, `src/security/rate-limit.ts`, `src/security/validation.ts:75` (`const EMAIL_RE` → `export const EMAIL_RE`), `test/helpers.ts`, `wrangler.jsonc`, `wrangler.jsonc.example`, `vitest.config.ts`, `.dev.vars.example`

**Interfaces:**
- Consumes: `sha256Hex(value): Promise<string>` from `src/security/auth.ts`; `readJson`, `invalid` and `EMAIL_RE` from `src/security/validation.ts`; `HttpError` from `src/types`; `checkIpLimit(env, req)` from `src/security/rate-limit.ts`.
- Produces:
  - `src/admin/auth.ts`:
    - `hashPassword(p): Promise<string>`
    - `verifyPassword(p, stored): Promise<boolean>`
    - `sameSecret(a, b): Promise<boolean>`
    - `createSession(db): Promise<string>`, which returns the Set-Cookie value
    - `CLEARED_COOKIE: string`
    - `sessionHash(req, db): Promise<string | null>`
    - `requireSession(req, db): Promise<string>`, which throws 401 `unauthorized`
    - `purgeSessions(db): Promise<void>`
  - `src/admin/routes.ts`:
    - `handleAdmin(req, env, route: string): Promise<Response>`
    - `type Handler = (req: Request, env: Env) => Promise<Response>`
    - `withSession(handler: Handler): Handler`
  - `test/helpers.ts`:
    - `SETUP_TOKEN = "test-setup-token"`
    - `adminCall(path, init?, testEnv?)`
    - `sessionCookie(res): string`, which returns `"nf_admin=<token>"`
    - `setupAdmin(): Promise<string>`, which returns the cookie

- [ ] **Step 1: Config.** Do this in both `wrangler.jsonc` and `wrangler.jsonc.example`:
  - add `{ "name": "ADMIN_RATE_LIMITER", "namespace_id": "1003", "simple": { "limit": 10, "period": 60 } }` to `ratelimits`, with the comment `// Per-IP limit on admin setup, login and password change: slows password guessing.`;
  - add `"ADMIN_SETUP_TOKEN"` to `secrets.required`;
  - add `//   ADMIN_SETUP_TOKEN  one-time token for the first /admin registration (any long random string)` to the secrets comment.

  Then:
  - in `vitest.config.ts` bindings, add `ADMIN_SETUP_TOKEN: "test-setup-token",`;
  - in `.dev.vars.example`, add `ADMIN_SETUP_TOKEN=change-me-to-a-long-random-string`;
  - run `npm run typecheck`. Expected: passes, and `worker-configuration.d.ts` now has `ADMIN_RATE_LIMITER: RateLimit` and `ADMIN_SETUP_TOKEN: string`.
- [ ] **Step 2: Migration.** Create `migrations/0006_admin.sql` with the SQL from the spec's "Data" section, verbatim.
- [ ] **Step 3: Test helpers.** Add the helpers from [Part 2](2026-10-15-admin-dashboard-part2.md) to `test/helpers.ts`.
- [ ] **Step 4: Failing tests.** Create `test/admin.test.ts` from Part 2. Run `npx vitest run test/admin.test.ts`. Expected: FAIL, because every `/admin/api/*` call answers `404 not_found`.
- [ ] **Step 5: Implement.** Write the code in [Part 3](2026-10-15-admin-dashboard-part3.md) (`auth.ts`, `routes.ts`) and the start of [Part 4](2026-10-15-admin-dashboard-part4.md) (`checkAdminLimit`, the `index.ts` edits), and export `EMAIL_RE`.
- [ ] **Step 6: Run.** Run `npx vitest run test/admin.test.ts`, then `npm test` and `npm run typecheck`. Expected: all pass.
- [ ] **Step 7: Commit.** Run `git add migrations/0006_admin.sql src test wrangler.jsonc.example vitest.config.ts .dev.vars.example`, then `git commit -m "feat(admin): one-time setup, login, sessions and password change"`.

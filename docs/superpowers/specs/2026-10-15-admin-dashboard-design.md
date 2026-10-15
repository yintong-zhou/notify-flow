# Admin dashboard (`/admin`) — Design

Date: 2026-10-15
Builds on: [MVP design](2026-10-08-notification-service-mvp-design.md) and [async sending](2026-10-11-async-queue-design.md)

## Goal

**Monitoring:** one operator opens a browser page, logs in, and sees whether emails were generated and submitted, which failed and why, and can look up a single delivery.

Success:
- The first visit with the setup token creates the only admin account. After that, registration is closed for good.
- The stats page shows counts per status, top errors, a time chart and a delivery search over the last 30 days (the retention window).
- The admin can change the password and log out of every session.

## Scope and roadmap

This is sub-project 1 of 3. Each later one gets its own spec:

1. **This spec:** auth (one-time setup, login, sessions), account (password change), stats and delivery search.
2. **Log viewer:** errors, warnings and info. Today the Worker logs only 4 error points.
3. **DB editor:** browse D1 tables and run queries. The Cloudflare dashboard (D1 → Console/Tables) already covers this.

## Decisions

- **One admin, enforced by the DB:** `CHECK (id = 1)` on `admin_user`, so a concurrent second setup fails on the `INSERT`.
- **Setup token:** registration requires the `ADMIN_SETUP_TOKEN` secret, so a stranger who reaches `/admin` first after a deploy cannot claim it.
- **Same Worker, static assets:** vanilla HTML/CSS/JS in `public/admin/`, served by Workers static assets. Data comes from JSON routes under `/admin/api/*`. It is same-origin, so there is no CORS, no build step and no dependency.
- **D1 sessions**, not signed cookies: revocable, and "log out everywhere" is a `DELETE`.
- **Read-only on `email_deliveries`:** the dashboard never updates delivery rows.
- **Separate from API-key auth:** `src/admin/` does not touch `security/auth.ts`. A client key never opens `/admin`, and a session never calls `/v1`.
- **Rejected:**
  - Cloudflare Access in front of `/admin`: it needs no code, but the requested flow is a self-registered login;
  - a separate Pages/SPA project: it adds build tooling, a second deploy and cross-site cookies;
  - server-rendered HTML in TypeScript: it mixes markup into the service code and makes tests awkward.

## Data (`migrations/0006_admin.sql`)

```sql
CREATE TABLE admin_user (
  id            INTEGER PRIMARY KEY CHECK (id = 1),  -- one admin only
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,                       -- pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>
  created_at    INTEGER NOT NULL
);
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,                        -- hex SHA-256 of the cookie value
  expires_at INTEGER NOT NULL                         -- unix seconds
);
```

## Auth and account routes

Every route lives under `/admin/api/`. Routes that change state accept only `Content-Type: application/json` and otherwise answer `415`.

| Route | Body | Result |
|---|---|---|
| `GET me` | — | `{registered, logged_in, email?}` |
| `POST setup` | `{setup_token, email, password}` | 201 + session cookie; 403 `invalid_setup_token`; 409 `already_registered` |
| `POST login` | `{email, password}` | 200 + session cookie; 401 `invalid_credentials` |
| `POST logout` | — | 204, deletes the session row, clears the cookie |
| `POST password` | `{current, new}` | 204, deletes every other session; 401 `invalid_credentials` |

- **Password:** PBKDF2-SHA256 via WebCrypto, a 16-byte random salt and 100 000 iterations (the Workers maximum), with a minimum length of 12. Verification uses a constant-time comparison. The `iterations` field is stored, so it can be raised later without a migration.
- **Setup token:** compared in constant time. A missing `ADMIN_SETUP_TOKEN` disables setup (`403`).
- **Session:** 32 random bytes in base64url, and the row stores its SHA-256. The cookie is `nf_admin=<token>; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=604800`. It lasts a fixed 7 days, with no sliding renewal.
- **Credentials:** a wrong email and a wrong password get the same `401 invalid_credentials`.
- **Rate limit:** `ADMIN_RATE_LIMITER` (per IP, 10 requests per 60 s) on `setup`, `login` and `password` answers `429 rate_limited`.
- **CSRF:** `SameSite=Strict` plus the JSON-only content type. A cross-site form cannot send `application/json` without a CORS preflight, which the Worker never approves.
- **Cleanup:** the existing daily cron also runs `DELETE FROM admin_sessions WHERE expires_at < unixepoch()`.
- Any other `/admin/api/*` route without a valid session answers `401 unauthorized`.

## Stats

`GET /admin/api/stats?window=24h|7d|30d` (default `24h`) runs three queries in one `DB.batch()`. All filter on `created_at >= unixepoch() - <window>`, which uses `idx_deliveries_created`.

```json
{
  "window": "24h",
  "by_status": { "accepted": 0, "queued": 2, "processing": 1, "retrying": 0, "submitted": 140, "failed": 3, "stalled": 1 },
  "errors": [{ "error_code": "smtp_failed", "client_id": "cl_…", "client_name": "shop", "template": "welcome", "count": 2 }],
  "series": [{ "bucket": 1792000800, "status": "submitted", "count": 12 }]
}
```

- **`stalled`:** rows in `processing` whose `COALESCE(claimed_at, created_at)` is more than `ABANDONED_AFTER_S` old (exported from `email-service.ts`, today 300 s). Today they turn `failed/abandoned` only when they are read. The dashboard reports them and does not close them. They are also counted in `processing`.
- **`errors`:** `GROUP BY error_code, client_id, template` over rows with an `error_code`, the top 20 by count, joined to `clients.name`.
- **`series`:** the bucket is `created_at - created_at % 3600` for `24h` and `% 86400` for `7d`/`30d`, in UTC, grouped by bucket and status.
- An invalid `window` answers `400 validation_error`.

> `ponytail:` a `GROUP BY` over up to 30 days of raw rows. That is fine up to a few hundred thousand deliveries per month. Past that, add a daily aggregate table that the cron fills.

## Delivery search

`GET /admin/api/deliveries?id=&recipient=&client_id=&template=&status=&error_code=&before=`

- Every filter is optional and uses an exact match. `recipient` is lowercased first, as stored.
- The order is `created_at DESC, id DESC`, 50 rows per page. `before=<created_at>:<id>` is the cursor; the response carries `next` (the cursor of the last row) or `null`.
- Each row returns every `email_deliveries` column plus `client_name`. No column holds content, variables or tokens, by the existing logging constraint.
- A malformed `before` or `status` answers `400 validation_error`.

## UI (`public/admin/`)

- `setup.html`, `login.html`, `index.html`, `app.js` and `style.css`. Pages carry no data, so serving them without auth is fine.
- `app.js` calls `GET me` first and routes to setup, login or the dashboard. Any `401` sends the user to the login page.
- The dashboard has:
  - a window selector and a refresh button (no auto-refresh);
  - status cards, with `failed` and `stalled` highlighted;
  - a stacked bar chart in inline SVG built by `app.js` (no chart library);
  - the error table, where clicking a row filters the search by that `error_code`;
  - a search form with a results table and "load more";
  - an account panel to change the password and log out.
- All values are inserted with `textContent`, never `innerHTML`: recipients and template names are caller-controlled.

## Config

In both `wrangler.jsonc` and `wrangler.jsonc.example`:
- `"assets": { "directory": "./public" }`. The Worker runs only when no file matches, so `/v1/*`, `/health` and `/admin/api/*` reach `handle()` unchanged.
- In `ratelimits`, add `{ "name": "ADMIN_RATE_LIMITER", "namespace_id": "1003", "simple": { "limit": 10, "period": 60 } }`.
- In `secrets.required`, add `ADMIN_SETUP_TOKEN`. It also goes in `.dev.vars.example`, and in the `vitest.config.ts` miniflare bindings for tests.

## Errors and logging

- The admin routes reuse `HttpError` and `errorResponse()` from `index.ts`, so the error shape is the same as `/v1`.
- Logs never contain the email, password, setup token or session token. Unexpected errors still log only `{error_code: "internal_error"}`.

## Testing (`test/admin.test.ts`)

- **Setup:** a wrong or missing token gets 403; the first setup gets 201 and a cookie; a second setup gets 409.
- **Login:** a wrong password and an unknown email both get the same 401. Success sets a cookie with `HttpOnly`, `Secure`, `SameSite=Strict` and `Path=/admin`. Logout and an expired session (row with `expires_at` in the past) get 401 afterwards.
- **CSRF:** a `POST` without `Content-Type: application/json` gets 415.
- **Password change:** the old password fails, the new one works, other sessions get 401, and the current one keeps working.
- **Stats:** after inserting rows with mixed statuses, ages and error codes, the counts, `stalled`, the top errors and the bucket boundaries are checked for each window.
- **Search:** each filter, and pagination where page 2 does not repeat page 1 and the last page returns `next: null`.
- **Isolation:** `/admin/api/*` rejects an API key, and `/v1/*` rejects the session cookie.
- **Not tested:** the static pages are checked by hand with `npm run dev`.

## Docs

- `docs/admin-dashboard.md`: setting the setup token, first login, what each counter means, and the 30-day limit. Linked from the docs site sidebar.
- `CLAUDE.md`: an `/admin` line in Architecture, and the `ADMIN_SETUP_TOKEN` secret under Configuration.
- `README.md`: a deploy step for `wrangler secret put ADMIN_SETUP_TOKEN`.

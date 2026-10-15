# Admin dashboard

The Worker serves a monitoring page at `/admin/`. It shows how many emails were submitted or failed, which errors happen most, a chart over time, and a search for single deliveries. It also lists logged errors and rejected requests, and has a SQL console on the D1 database. There is one admin account, created on the first visit.

## Set up

1. Store a long random string as the setup token:
   ```bash
   npx wrangler secret put ADMIN_SETUP_TOKEN
   ```
   For `npm run dev`, put `ADMIN_SETUP_TOKEN=…` in `.dev.vars` instead, and open `http://localhost:8787/admin/`: over plain HTTP, browsers keep the `Secure` session cookie for `localhost` but may drop it for `127.0.0.1`, and the login does not stick.
2. Apply the migrations and deploy: `npm run db:migrate:remote`, then `npm run deploy`.
3. Open `https://<worker>.<subdomain>.workers.dev/admin/`. Enter the setup token, your email and a password of at least 12 characters.

Registration then closes: a second setup answers `409 already_registered`, so the token does nothing afterwards. Keep the secret set anyway: `ADMIN_SETUP_TOKEN` is a required secret, and `npm run deploy` fails without it. To retire the value, overwrite it with a new random string.

**Upgrading an existing deployment:** set `ADMIN_SETUP_TOKEN` once before the next `npm run deploy`, as well as running the migrations.

**Lost password:** delete the account, set the token again, and register again:

```bash
npx wrangler d1 execute notify-flow --remote --command "DELETE FROM admin_sessions; DELETE FROM admin_user;"
```

## What it shows

The cards, chart, errors and deliveries come from the delivery log (`email_deliveries`), which keeps 30 days. The log never stores email content or variables, so the dashboard shows **whether** an email went out, never **what** it said.

- **Cards:** deliveries per status in the chosen window (24 hours, 7 days or 30 days). Statuses are described in [Delivery statuses](api-reference.md#delivery-statuses). `submitted` means the SMTP server accepted the email, not that it reached the inbox.
- **`stalled`:** deliveries in `processing` for more than 5 minutes. The send died midway, so the email may or may not have gone out. They are also counted in `processing`. They turn `failed` with `error_code: "abandoned"` when read through `GET /v1/email/:id`.
- **Chart:** deliveries per hour (24 hours) or per UTC day, stacked by status.
- **Errors:** the 20 most frequent `error_code` × client × template combinations. Click a row to list those deliveries.
- **Deliveries:** search by message id, recipient, client id, template, status or error code, newest first, 50 at a time.

## Logs

The **Logs** section lists what went wrong, newest first, filtered by level, code, client, IP or message id.

- **error:** server errors (`smtp_failed`, `smtp_misconfigured`, `queue_unavailable`, `internal_error`) and queued sends that failed for good.
- **warn:** failed SMTP attempts before a retry (`smtp_attempt_failed`, e.g. `smtp_timeout attempt 2/3`), and 401, 403 and 429 responses.
- **info:** other 4xx responses under `/v1` and `/admin/api` (`validation_error`, `template_not_found`, …). 404s on other paths are not logged.

Each row holds the time, level, code, HTTP status, method and path (never the query string), client, message id, the caller's full IP and a short detail. Variables, email content, tokens, credentials and SMTP reply text are never stored. At most about 30 warn/info rows per minute are kept per IP (per /64 for IPv6, so rotating addresses does not help), so a scanner cannot flood the table; errors and SMTP attempts are always kept. Rows, IPs included, are deleted after 30 days.

Click a message id in Deliveries to see that email's events, or an IP to see everything it triggered.

## Database

The **Database** section browses and changes the D1 database directly. Click a table to see it 50 rows at a time, or type any SQL statement and press **Run** (or Ctrl+Enter).

- **Writes are immediate and unrestricted.** `UPDATE`, `DELETE`, `DROP` run as typed, with no confirmation and no undo; the admin session is the only gate. You can also lock yourself out by changing `admin_user` or `admin_sessions`.
- **At most 1000 rows** come back; D1 still reads the whole result, so add `LIMIT` to large queries.
- **Several statements** separated by `;` all run, but only the last one's rows are shown. They run as one unit: if one fails, none of them is applied.
- **Duplicate column names** (`SELECT a.id, b.id …`) collapse into one: alias them (`b.id AS b_id`).
- The SQL text and D1's error messages are never written to the logs: a failed statement is logged only as `sql_error`.

## Security

- **Sessions:** a session cookie lasts 7 days and is `HttpOnly`, `Secure` and `SameSite=Strict`. Only a hash of it is stored.
- **Separate from API keys:** client API keys do not open `/admin`, and the session does not work on `/v1`.
- **Login rate limit:** setup, login and password change allow 10 attempts per minute per IP.
- **Password change:** changing the password logs out every other session.
- **Headers:** the pages are served with a Content Security Policy that blocks other origins and framing (`public/_headers`), and API responses are never cached.

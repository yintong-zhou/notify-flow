# Admin dashboard

The Worker serves a monitoring page at `/admin/`. It shows how many emails were submitted or failed, which errors happen most, a chart over time, and a search for single deliveries. There is one admin account, created on the first visit.

## Set up

1. Store a long random string as the setup token:
   ```bash
   npx wrangler secret put ADMIN_SETUP_TOKEN
   ```
   For `npm run dev`, put `ADMIN_SETUP_TOKEN=…` in `.dev.vars` instead.
2. Apply the migrations and deploy: `npm run db:migrate:remote`, then `npm run deploy`.
3. Open `https://<worker>.<subdomain>.workers.dev/admin/`. Enter the setup token, your email and a password of at least 12 characters.

Registration then closes: a second setup answers `409 already_registered`. You can delete the token afterwards with `npx wrangler secret delete ADMIN_SETUP_TOKEN`. Without it, setup is always refused.

**Lost password:** delete the account, set the token again, and register again:

```bash
npx wrangler d1 execute notify-flow --remote --command "DELETE FROM admin_sessions; DELETE FROM admin_user;"
```

## What it shows

Everything comes from the delivery log (`email_deliveries`), which keeps 30 days. The log never stores email content or variables, so the dashboard shows **whether** an email went out, never **what** it said.

- **Cards:** deliveries per status in the chosen window (24 hours, 7 days or 30 days). Statuses are described in [Delivery statuses](api-reference.md#delivery-statuses). `submitted` means the SMTP server accepted the email, not that it reached the inbox.
- **`stalled`:** deliveries in `processing` for more than 5 minutes. The send died midway, so the email may or may not have gone out. They are also counted in `processing`. They turn `failed` with `error_code: "abandoned"` when read through `GET /v1/email/:id`.
- **Chart:** deliveries per hour (24 hours) or per UTC day, stacked by status.
- **Errors:** the 20 most frequent `error_code` × client × template combinations. Click a row to list those deliveries.
- **Deliveries:** search by message id, recipient, client id, template, status or error code, newest first, 50 at a time.

## Security

- **Sessions:** a session cookie lasts 7 days and is `HttpOnly`, `Secure` and `SameSite=Strict`. Only a hash of it is stored.
- **Separate from API keys:** client API keys do not open `/admin`, and the session does not work on `/v1`.
- **Login rate limit:** setup, login and password change allow 10 attempts per minute per IP.
- **Password change:** changing the password logs out every other session.

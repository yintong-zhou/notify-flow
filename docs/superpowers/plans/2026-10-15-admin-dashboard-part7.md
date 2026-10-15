# Admin Dashboard Plan — Part 7: Task 3 CSS and manual check, Task 4 docs

[← Part 6](2026-10-15-admin-dashboard-part6.md) · [Part 1](2026-10-15-admin-dashboard.md)

## `public/admin/style.css`

```css
:root { color-scheme: light dark; --bg: #fff; --fg: #1d2129; --muted: #6b7280; --line: #e3e5e8; --card: #f6f7f9; --bad: #d64545; --ok: #2e9e5b; font: 14px/1.4 system-ui, sans-serif; }
@media (prefers-color-scheme: dark) { :root { --bg: #15171a; --fg: #e6e8eb; --muted: #9aa0a8; --line: #2a2e33; --card: #1e2125; } }
body { margin: 0; background: var(--bg); color: var(--fg); }
main { max-width: 1100px; margin: 0 auto; padding: 16px; }
header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
header h1 { margin: 0 auto 0 0; }
h2 { margin-top: 32px; font-size: 1.1rem; }
.box { display: grid; gap: 12px; max-width: 360px; }
label { display: grid; gap: 4px; }
input, select, button { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
button { cursor: pointer; background: var(--card); }
.error { color: var(--bad); margin: 0; }
.ok { color: var(--ok); margin: 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-top: 16px; }
.card { display: grid; background: var(--card); border-radius: 8px; padding: 12px; }
.card span { color: var(--muted); }
.card strong { font-size: 1.6rem; }
.card.failed strong, .card.stalled strong { color: var(--bad); }
#chart { display: block; width: 100%; height: 160px; background: var(--card); border-radius: 8px; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px; color: var(--muted); }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 4px; border-radius: 2px; background: var(--swatch); }
.search { display: flex; flex-wrap: wrap; gap: 8px; }
.search .error { flex-basis: 100%; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
#errors tbody tr { cursor: pointer; }
#errors tbody tr:hover { background: var(--card); }
```

## Task 3 manual check

1. If you have a `.dev.vars`, add `ADMIN_SETUP_TOKEN=local-setup-token` to it; otherwise run `cp .dev.vars.example .dev.vars`. Then run `npm run db:migrate:local` and `npm run dev`.
2. Open `http://localhost:8787/admin/`. The setup form appears.
   - A wrong token shows `Invalid setup token`.
   - The right token, with an email and a 12+ character password, opens the dashboard.
   - With an empty DB (Review Focus 5) the cards are all `0`, the chart is empty, both tables are empty, and there is no error.
3. Run `npm run client:create -- demo` and copy the client id. Then run the following, with `<id>` replaced by that client id:
   ```bash
   npx wrangler d1 execute notify-flow --local --command "INSERT INTO email_deliveries (id, request_id, client_id, template, provider, recipient, status, error_code, created_at) VALUES ('msg_00000000-0000-0000-0000-000000000001','r1','<id>','welcome','gmail','<b>x</b>@example.com','failed','smtp_failed',unixepoch()-3600), ('msg_00000000-0000-0000-0000-000000000002','r2','<id>','welcome','gmail','a@example.com','submitted',NULL,unixepoch()-7200), ('msg_00000000-0000-0000-0000-000000000003','r3','<id>','reset','gmail','a@example.com','processing',NULL,unixepoch()-900);"
   ```
4. Click Refresh and check:
   - the cards show `submitted 1`, `failed 1`, `stalled 1` and `processing 1`;
   - the chart shows 3 bars, and hovering a bar shows a tooltip;
   - the recipient reads literally as `<b>x</b>@example.com`, not in bold (the `textContent` rule);
   - clicking the `smtp_failed` error row filters the deliveries to that one row;
   - switching to 7d and then 30d still shows the 3 rows.
5. Reload the page: you are still logged in.
6. **Review Focus 1:** in Account, a wrong current password shows the error under the form and you stay on the dashboard. The right current password shows "Password changed".
7. Click Log out: the login form appears, and logging in with the new password works.
8. In the browser dev tools, at 375 px width, the page itself does not scroll horizontally. Only the tables scroll.

---

### Task 4: Docs

**Files:**
- Create: `docs/admin-dashboard.md`
- Modify: `docs/.vitepress/config.mts` (sidebar), `CLAUDE.md`, `README.md:59`

**Interfaces:** none.

- [ ] **Step 1:** Create `docs/admin-dashboard.md` with the content below.
- [ ] **Step 2:** In `docs/.vitepress/config.mts`, in the "Documentation" sidebar items, add `{ text: "Admin dashboard", link: "/admin-dashboard" },` after the "AI integration prompt" entry.
- [ ] **Step 3:** In `README.md`, after line 59 (`npx wrangler secret put SMTP_USERNAME …`), add:
  ```bash
  npx wrangler secret put ADMIN_SETUP_TOKEN  # long random string, used once to register the /admin account
  ```
  This sits inside the `getting-started` region, so it must contain no relative link.
- [ ] **Step 4:** In `CLAUDE.md`:
  - under **Architecture**, after the "Events" paragraph, add: `Admin (`/admin/`): static pages in `public/admin/` (Workers static assets) call `/admin/api/*` (`src/admin/`), authenticated by a D1 session cookie, never by API key. One admin, created once with the `ADMIN_SETUP_TOKEN` secret. Stats and search only read `email_deliveries`.`;
  - in **Hard constraints → Configuration**, add `ADMIN_SETUP_TOKEN` to the list of secrets.
- [ ] **Step 5:** Run `npm run docs:build`. Expected: it succeeds with no dead links. Run `wc -l docs/admin-dashboard.md README.md CLAUDE.md`. Expected: each is under 200.
- [ ] **Step 6: Commit.** Run `git add docs CLAUDE.md README.md`, then `git commit -m "docs: admin dashboard"`.

## `docs/admin-dashboard.md`

````md
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
````

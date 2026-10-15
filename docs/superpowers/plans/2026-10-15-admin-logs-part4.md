# Admin Log Viewer Plan — Part 4: Task 4 CSS and check, Task 5 docs

[← Part 3](2026-10-15-admin-logs-part3.md) · [Part 1](2026-10-15-admin-logs.md)

### Task 4 (continued)

- [ ] **Step 3: `style.css`.**
  - Add `--warn: #b7791f;` to the light `:root` and `--warn: #e0a020;` to the dark one.
  - Append:

```css
.link { cursor: pointer; text-decoration: underline dotted; }
.level-error { color: var(--bad); font-weight: 600; }
.level-warn { color: var(--warn); font-weight: 600; }
```

- [ ] **Step 4: Checks.** Run `node --check public/admin/app.js`, `npm test` and `npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Headless check.**
  - Run `npm run db:migrate:local`.
  - Seed `app_logs` locally with 3 rows:
    - `warn unauthorized`, with path `/v1/<script>alert(1)</script>` and ip `198.51.100.9`;
    - `warn smtp_attempt_failed`, with message_id `msg_00000000-0000-0000-0000-000000000001`;
    - `error smtp_failed`, with the same message id and ip.
  - Start `npm run dev`. In headless Chrome (CDP, as in the dashboard plan's check), log in and assert:
    - the Logs table has 3 rows, and `#logs script` matches 0 elements (Review Focus 3);
    - clicking the `…0001` id in Deliveries leaves 2 log rows;
    - clicking the IP `198.51.100.9` leaves 1 row;
    - the level cells have the classes `level-warn` and `level-error`;
    - Deliveries "Load more" still works.

  Stop the dev server.
- [ ] **Step 6: Commit.** Run `git add public`, then `git commit -m "feat(logs): Logs section in the dashboard"`.

### Task 5: Docs

- [ ] **Step 1:** In `docs/admin-dashboard.md`, before `## Security`, add a `## Logs` section that says:
  - **Logged:** server errors (error); failed SMTP attempts before a retry (warn); 401, 403 and 429 (warn); other 4xx under `/v1` and `/admin/api` (info).
  - **Fields:** time, level, code, status, method and path (no query string), client, message id, IP, and a short detail such as `smtp_timeout attempt 2/3`.
  - **Rate:** at most 30 warn/info rows per minute per IP. Errors and SMTP attempts are always kept.
  - **Retention:** rows, including the full IP, are deleted after 30 days.
  - **Never stored:** variables, content, tokens, credentials, SMTP reply text.
  - **Links:** a message id in Deliveries opens its logs, and an IP filters by it.
- [ ] **Step 2:** In `CLAUDE.md`:
  - add an Architecture line: `Logging: services/logger.ts — log() writes app_logs and never throws; index.ts errorResponse logs every error response (warn/info capped by LOG_RATE_LIMITER per IP); send retries log smtp_attempt_failed.`;
  - in the "Logs and delivery records" constraint, replace `` `console.error` logs only `{id, client_id, error_code}`. `` with `` Log events go only through `log()` with the `app_logs` fields: never a query string, `SmtpError.message` or an unexpected error's message. ``.
- [ ] **Step 3:** Run `npm run docs:build` (expected: no dead links) and `wc -l docs/admin-dashboard.md CLAUDE.md` (expected: each under 200).
- [ ] **Step 4: Commit.** Run `git add docs CLAUDE.md`, then `git commit -m "docs: admin logs"`.

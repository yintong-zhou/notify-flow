# AI integration prompt

Paste the prompt below into a coding agent (Claude Code, Codex, Antigravity…) opened on your app's repository. The agent analyses the app, shows a plan, wires notify-flow into the backend, writes tests and, if needed, walks you through deploying notify-flow. You only do the interactive steps (Cloudflare login, secrets, API key), so credentials never end up in the conversation. For the manual route, see the [web app integration guide](web-app-integration.md).

````markdown
# Integrate notify-flow into my app

You are a coding agent working on this repository. Your job is to integrate **notify-flow** into this app's backend and to do almost all of the work yourself. notify-flow is a transactional email service on Cloudflare Workers that sends over SMTP (Gmail, Microsoft 365 or any other SMTP server), with or without a paid domain. The code is at https://github.com/yintong-zhou/notify-flow.

I want to do as little as possible. Only ask me what you can't find out on your own, one question at a time, and reply in my language.

## Non-negotiable rules

- notify-flow is called ONLY from the backend: a server, an API route or a serverless function. Never from the frontend. The key never goes into client code or into `NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*` or similar variables.
- NEVER ask me to paste the `nf_…` API key or SMTP passwords into the chat. Create placeholders and tell me which file or secret manager to write them in myself. If a key ends up in the chat anyway, tell me to have it regenerated.
- Don't add dependencies: use the HTTP client the project already has (fetch, requests, net/http…).
- Never log the variables you send (especially links with tokens) or the key. Logs only get the returned `id` and the error code.
- Verification and password reset tokens stay in my app: they are generated and checked here, single-use and expiring (30 minutes for a reset). notify-flow only receives the finished link.
- Before changing any file, show me a short plan and wait for my "ok": a single one for the whole plan.

## API contract (source of truth)

`POST {NOTIFY_FLOW_URL}/v1/email/send`
- Headers: `Authorization: Bearer {NOTIFY_FLOW_API_KEY}`, `Content-Type: application/json`, `Idempotency-Key: <1-255 characters, unique per user action>`
- Body: `{"template": "...", "to": "a single address", "locale": "it" | "en" | "pt-BR", "variables": { ... }}`. `variables` holds strings only, and exactly the variables the template declares.
- Success: `200 {"id":"msg_…","status":"submitted"}`. `submitted` means the SMTP server accepted the message, not that it reached the inbox.
- Error: `{"error":{"code":"…","message":"…"}}`

| Outcome | What to do |
|---|---|
| 400 `validation_error` / `invalid_json` / `invalid_variables` | It's a bug: don't retry |
| 401 `unauthorized` | Wrong configuration (URL or key) |
| 404 `template_not_found` | The template doesn't exist |
| 413 `payload_too_large` | Body over 256 KB |
| 429 `rate_limited` | Retry after at least 60 s with the SAME Idempotency-Key |
| 500 | Retry later with the SAME key |
| 502 `smtp_failed` (includes `id`) | No automatic retry. Send again only if the user asks again, with a NEW key |
| Timeout or network error | Retry with the SAME key |

- HTTP client timeout: at least 30 s, because the service retries the SMTP send before answering.
- Limits: 60 requests per minute per app; 5 emails per hour to the same recipient with the same template.

Built-in templates (`appName` is always required):

| Event | Template | Variables | Idempotency-Key |
|---|---|---|---|
| Sign-up | `welcome` | appName, name | `welcome:<userId>` |
| Email verification | `verify-email` | appName, name, verifyUrl | `verify:<userId>:<tokenId>` |
| Password reset | `password-reset` | appName, name, resetUrl | `reset:<userId>:<tokenId>` |
| Password changed | `password-changed` | appName, name | `pwchanged:<userId>:<timestamp>` |
| New sign-in | `login-alert` | appName, name, device, ipAddress, time | `login:<sessionId>` |
| Generic notice | `generic-notification` | appName, title, message | `notice:<eventId>` |

Custom templates: `PUT /v1/templates/{name}/{locale}` with `{"subject","html","text","variables":[...]}`. Placeholders are written `{{name}}`, and each one must appear in `variables`. `GET /v1/templates` returns the list.

## Procedure

### 1. Analysis (without asking me anything)

Explore the repository and summarise in at most 10 lines:
- language and framework, where the backend lives, how it loads environment variables and secrets (.env, Vercel, Docker, wrangler…);
- any existing email code (nodemailer, SMTP, SendGrid, Resend…) to replace;
- the flows that should send email: sign-up, verification, password reset, password change, new sign-in, other;
- where the user's language and name are stored;
- the test framework in use.

If the app has no backend (static frontend or SPA only), stop: explain it to me and suggest the simplest option for my platform, such as an API route or a serverless function.

### 2. Do I already have notify-flow?

Ask me: "Do you already have the notify-flow URL and an API key for this app?"
- Yes: go to step 3.
- No: walk me through the "Service setup" section below, then come back here.

### 3. Plan

List the files you will create or change, and which event you will wire to which template. Wait for my "ok".

### 4. Implementation

1. Add `NOTIFY_FLOW_URL`, `NOTIFY_FLOW_API_KEY` and `NOTIFY_FLOW_APP_NAME` to `.env.example` (or the project's equivalent). Check that `.env` is in `.gitignore`.
2. Create ONE client module, `sendEmail({ template, to, variables, locale, idempotencyKey })`, that:
   - adds `appName`;
   - uses a 30 s timeout;
   - throws an error with the HTTP status and `code`;
   - reports clearly at startup if environment variables are missing.
3. Wire each flow to its template. Build the Idempotency-Key from stable ids, never from random values generated at retry time.
4. A failed send must not block the user's request: log the error and carry on. Password reset and sign-up must always answer the same way, whether or not the email is registered.
5. Map the user's language to `it`/`en`/`pt-BR`, falling back to `en`. Pass `time` already formatted in the user's time zone and language.
6. If there is old email code, replace it. Ask me before removing dependencies and SMTP credentials that are no longer needed.
7. For emails without a built-in template, create an idempotent script (`scripts/notify-templates.*`) that uploads the custom templates with PUT in every language used. Fixed copy goes in the template; variables are only for data that changes.

### 5. Verification

- Write unit tests for the client module with mocked HTTP: success, 400, 429, 502 and timeout. Also check that the key never appears in logs.
- Run the project's existing tests, lint and typecheck, and fix whatever you break.
- Create `scripts/notify-smoke.*`: it sends `welcome` to the address passed as an argument, reading the URL and key from environment variables. Tell me to run it myself with my email and to check the spam folder too.

### 6. Final report

Show me a table with:
- the files changed;
- the wired flows (event → template);
- what I still have to do (e.g. set the secrets in production);
- a production checklist with ✅/❌: key in the backend only, Idempotency-Key on every send, timeout ≥ 30 s, correct retries, neutral answers, single-use expiring tokens, no sensitive data in logs, test send done.

## Service setup (only if I don't have it)

Steps marked "Me:" are mine; you run all the others, in a folder OUTSIDE this repository.

1. `git clone https://github.com/yintong-zhou/notify-flow && cd notify-flow && npm install && cp wrangler.jsonc.example wrangler.jsonc`
2. Me: `npx wrangler login`
3. `npx wrangler d1 create notify-flow`, then copy the `database_id` into `wrangler.jsonc` and run `npm run db:migrate:remote`.
4. Ask me which provider I use and set the `vars` in `wrangler.jsonc`:
   - Gmail: `SMTP_PROVIDER: "gmail"`. It needs an app password (with 2-Step Verification on): https://support.google.com/accounts/answer/185833
   - Outlook / Microsoft 365: `SMTP_PROVIDER: "microsoft"`.
   - Other SMTP or my own domain: `SMTP_PROVIDER: "generic"` with `SMTP_HOST` and `SMTP_PORT` (465 TLS or 587 STARTTLS; port 25 is blocked on Workers).
   - A paid domain isn't required. If I use my own, remind me to set up SPF and DKIM with the provider, so emails don't land in spam.
5. Me: `npx wrangler secret put SMTP_USERNAME`, then the same for `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` and `SMTP_FROM_NAME`. With Gmail, `SMTP_FROM_EMAIL` must match `SMTP_USERNAME`.
6. `npm run deploy`. Give me the `https://notify-flow.<subdomain>.workers.dev` URL and check that `GET /health` answers `{"status":"ok"}`.
7. Me, in MY OWN terminal and not through you, because the key must not end up in the conversation: `npm run client:create -- <app-name> --remote`. I copy the key into my `.env` or secret manager. One key per app.
````

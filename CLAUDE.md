# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

`wrangler.jsonc` is git-ignored: on a fresh clone run `cp wrangler.jsonc.example wrangler.jsonc` first (tests, dev and typecheck all read it). Config changes go in both files.

- `npm test` — all tests (vitest in workerd via `@cloudflare/vitest-plugin`); one file: `npx vitest run test/send-api.test.ts`; one test: `npx vitest run -t "retries a transient"`
- `npm run typecheck` — regenerates `worker-configuration.d.ts` (`wrangler types --strict-vars=false`) then `tsc`
- `npm run dev` / `npm run deploy`
- `npm run db:migrate:local` / `db:migrate:remote`
- `npm run client:create -- <name> [--remote]` — creates a client, prints its API key once
- `npm run push:keys` — prints a new VAPID key pair for Web Push (never rotate keys in use)
- `npm run docs:dev` / `docs:build` / `docs:preview` — VitePress site from `docs/` (build fails on dead links)

**Testing note:** `vi.mock` does not intercept modules in the Workers pool. Inject dependencies instead (`handle(req, env, send)`, `sendMail(config, msg, connectFn, timeoutMs)`, `handleQueue(batch, env, send)`); `test/helpers.ts` has `call()`, `recorder()` and `fakeQueue()` (always inject it for async tests: the real binding would reach real SMTP), and `test/fake-smtp.ts` is a scripted SMTP server. For push, `pushCall()` (push configured, with the push HTTP call injected as `fetchPush`) and `pushRecorder()` (a fake push service that records requests and scripts outcomes per endpoint).

## Docs

- Requirements: `notification-service.md` (continues in `docs/requirements/`)
- Design spec: `docs/superpowers/specs/2026-10-08-notification-service-mvp-design.md` (+ `-part2.md`)
- Web app integration guide: `docs/web-app-integration.md` (+ `-flows.md`, `-async.md`, `-events.md`, `-push.md`); push API contract: `docs/api-reference-push.md`
- Site: `docs/index.md`, `docs/getting-started.md` (include README regions `<!-- #region … -->`: keep relative links out of them); API contract: `docs/api-reference*.md` (`docs/ai-integration-prompt.md` and `docs/ai-management-page-prompt.md` keep copies, update all)

Keep every Markdown file under 200 lines: split a longer one into linked parts, or tighten it.

`AGENT.md` is a separate document with instructions for an LLM agent that runs inside a serverless backend (directives, tools, runs). It does not describe this service's code, so don't conflate the two.

## What this is

A transactional email service running on Cloudflare Workers (TypeScript). It is meant to be shared by several applications, which call it over REST. It talks SMTP directly and does not use Resend, SendGrid, Mailgun or similar services. Callers are other backends, never frontends. It has no runtime dependencies.

## Architecture

Request flow: `index.ts` (router) → `security/` (auth, client rate limit, validation) → `routes/` → `services/email-service.ts` (idempotency, recipient limit, retries, delivery log) → `templates/renderer.ts` → `smtp/smtp-client.ts` → SMTP server.

Async (`Prefer: respond-async`): the route enqueues to `EMAIL_QUEUE` and answers `202 queued`; the same Worker's `queue()` handler (`services/queue-consumer.ts`) claims the row atomically (Queues deliver at least once), renders and sends once, then acks or retries (5 attempts). `GET /v1/email/:id` returns the status.

Events (`POST /v1/notifications`): `routes/notifications.ts` resolves the event to a template name (the client's `event_routes` row, then `BUILTIN_EVENTS` in `templates/events.ts`) and calls the same `dispatch` as `/v1/email/send`; `/v1/events` manages the mappings.

Admin (`/admin/`): static pages in `public/admin/` (Workers static assets) call `/admin/api/*` (`src/admin/`), authenticated by a D1 session cookie, never by API key. One admin, created once with the `ADMIN_SETUP_TOKEN` secret. Stats and search only read `email_deliveries`; the Database section (`POST /admin/api/sql`) runs any SQL on D1; the Clients panel (`GET /admin/api/clients`, `POST /admin/api/client-push`) holds the per-client push switch. See `docs/admin-dashboard.md`.

Push (`/v1/push/*`, opt-in per client): `src/push/routes.ts` runs the gates (`503 push_not_configured` unless the VAPID vars and secret are set, `403 push_disabled` unless `clients.push_enabled`; `DELETE /v1/push/subscriptions` is exempt) → `validation.ts` (endpoint host allowlist as the SSRF guard) → `subscriptions.ts` (`push_subscriptions`, 10 newest per user) → `sender.ts` (idempotency, hourly limit inside the `push_deliveries` `INSERT`, built-in `templates.ts`, RFC 8291 encryption and VAPID signing from `crypto.ts`, one request per device with retries; 404/410 delete the subscription). Admin switch: `docs/admin-dashboard.md#web-push`.

Logging: `services/logger.ts` — `log()` writes `app_logs` and never throws; `index.ts` `errorResponse` logs every error response (warn/info capped per IP by `LOG_RATE_LIMITER`); send retries log `smtp_attempt_failed` and push retries `push_attempt_failed`.

- **Templates only.** Callers choose a template and pass variables. They never send a subject or HTML. Templates come from D1 per client (`templates` table, managed via `/v1/templates`), with fallback to the built-ins in `templates/defaults.ts`, then to `en`. Variables must match the template's declared list exactly. This is a core anti-abuse guarantee, not a convenience.
- **Generic SMTP client with presets.** `smtp-client.ts` implements EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA, QUIT and the MIME message. The Gmail, Microsoft and generic presets live in `smtp/provider.ts`. The service layer must not depend on a specific provider.
- **Raw TCP.** On Workers, use `connect()` from `cloudflare:sockets`. For STARTTLS, use `secureTransport: "starttls"` together with `socket.startTls()`. Outbound port 25 is blocked on Workers.
- **No auth logic.** The service only delivers mail. Token generation and user checks stay in the calling backend.

## Hard constraints from the spec

- **Auth:** each client gets its own API key, sent as `Authorization: Bearer` or `X-API-Key`. Keys are stored only as hex SHA-256 in `clients.key_hash`.
- **Configuration:** `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` and `ADMIN_SETUP_TOKEN` are secrets, plus the optional secret `VAPID_PRIVATE_KEY` (not in `secrets.required`: a deployment without push must still deploy). `SMTP_PROVIDER`, `SMTP_AUTH_TYPE`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `RECIPIENT_LIMIT_PER_HOUR`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` and `PUSH_LIMIT_PER_HOUR` are `vars` in `wrangler.jsonc`. A Worker can't have a secret and a var with the same name.
- **Idempotency:** honor the `Idempotency-Key` header, and never send the same message twice. A replay is answered before the recipient limit.
- **Rate limiting:** 600 requests per 60 s per IP before auth, 60 per 60 s per client (Rate Limiting bindings, every `/v1/*` route except `/v1/push/*`), 600 per 60 s per client on `/v1/push/*` (`PUSH_RATE_LIMITER`), 10 per 60 s per IP on admin setup/login/password (`ADMIN_RATE_LIMITER`), and `RECIPIENT_LIMIT_PER_HOUR` per client, recipient and template (counted inside the delivery `INSERT`, so it is atomic; failed sends excluded), and `PUSH_LIMIT_PER_HOUR` per client, user and conversation (the tag, or the template when untagged; same atomic `INSERT`).
- **Logs and delivery records** (`email_deliveries`, `push_deliveries`) must never contain variables, rendered content, tokens, reset URLs or credentials. Log events go only through `log()` with the `app_logs` fields: never a query string, `SmtpError.message` or an unexpected error's message.
- **Statuses:** `accepted`, `queued`, `processing`, `submitted`, `failed`, `retrying`. Use `submitted` and never `delivered`, because SMTP acceptance does not prove inbox delivery.

## Not in the MVP (spec roadmap)

HMAC request signing (`X-Client-Id`, `X-Timestamp`, `X-Signature`), XOAUTH2, encrypted per-tenant SMTP credentials stored in a database.

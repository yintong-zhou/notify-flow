# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

`wrangler.jsonc` is git-ignored: on a fresh clone run `cp wrangler.jsonc.example wrangler.jsonc` first (tests, dev and typecheck all read it). Config changes go in both files.

- `npm test` — all tests (vitest in workerd via `@cloudflare/vitest-plugin`); one file: `npx vitest run test/send-api.test.ts`; one test: `npx vitest run -t "retries a transient"`
- `npm run typecheck` — regenerates `worker-configuration.d.ts` (`wrangler types --strict-vars=false`) then `tsc`
- `npm run dev` / `npm run deploy`
- `npm run db:migrate:local` / `db:migrate:remote`
- `npm run client:create -- <name> [--remote]` — creates a client, prints its API key once

**Testing note:** `vi.mock` does not intercept modules in the Workers pool. Inject dependencies instead (`handle(req, env, send)`, `sendMail(config, msg, connectFn, timeoutMs)`); `test/helpers.ts` has `call()` and `recorder()`, and `test/fake-smtp.ts` is a scripted SMTP server.

## Docs

- Requirements: `notification-service.md` (continues in `docs/requirements/`)
- Design spec: `docs/superpowers/specs/2026-10-08-notification-service-mvp-design.md` (+ `-part2.md`)
- Web app integration guide: `docs/web-app-integration.md` (+ `docs/web-app-integration-flows.md`)

Keep every Markdown file under 200 lines: split a longer one into linked parts, or tighten it.

`AGENT.md` is a separate document with instructions for an LLM agent that runs inside a serverless backend (directives, tools, runs). It does not describe this service's code, so don't conflate the two.

## What this is

A transactional email service running on Cloudflare Workers (TypeScript). It is meant to be shared by several applications, which call it over REST. It talks SMTP directly and does not use Resend, SendGrid, Mailgun or similar services. Callers are other backends, never frontends. It has no runtime dependencies.

## Architecture

Request flow: `index.ts` (router) → `security/` (auth, client rate limit, validation) → `routes/` → `services/email-service.ts` (idempotency, recipient limit, retries, delivery log) → `templates/renderer.ts` → `smtp/smtp-client.ts` → SMTP server.

- **Templates only.** Callers choose a template and pass variables. They never send a subject or HTML. Templates come from D1 per client (`templates` table, managed via `/v1/templates`), with fallback to the built-ins in `templates/defaults.ts`, then to `en`. Variables must match the template's declared list exactly. This is a core anti-abuse guarantee, not a convenience.
- **Generic SMTP client with presets.** `smtp-client.ts` implements EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA, QUIT and the MIME message. The Gmail, Microsoft and generic presets live in `smtp/provider.ts`. The service layer must not depend on a specific provider.
- **Raw TCP.** On Workers, use `connect()` from `cloudflare:sockets`. For STARTTLS, use `secureTransport: "starttls"` together with `socket.startTls()`. Outbound port 25 is blocked on Workers.
- **No auth logic.** The service only delivers mail. Token generation and user checks stay in the calling backend.

## Hard constraints from the spec

- **Auth:** each client gets its own API key, sent as `Authorization: Bearer` or `X-API-Key`. Keys are stored only as hex SHA-256 in `clients.key_hash`.
- **Configuration:** `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` and `SMTP_FROM_NAME` are secrets. `SMTP_PROVIDER`, `SMTP_AUTH_TYPE`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` and `RECIPIENT_LIMIT_PER_HOUR` are `vars` in `wrangler.jsonc`. A Worker can't have a secret and a var with the same name.
- **Idempotency:** honor the `Idempotency-Key` header, and never send the same message twice. A replay is answered before the recipient limit.
- **Rate limiting:** 300 requests per 60 s per IP before auth, 60 per 60 s per client (Rate Limiting bindings, every `/v1/*` route), and `RECIPIENT_LIMIT_PER_HOUR` per client, recipient and template (counted inside the delivery `INSERT`, so it is atomic; failed sends excluded).
- **Logs and delivery records** (`email_deliveries`) must never contain variables, rendered content, tokens, reset URLs or credentials. `console.error` logs only `{id, client_id, error_code}`.
- **Statuses:** `accepted`, `queued`, `processing`, `submitted`, `failed`, `retrying`. Use `submitted` and never `delivered`, because SMTP acceptance does not prove inbox delivery.

## Not in the MVP (spec roadmap)

Cloudflare Queues (API Worker → Queue → Email Worker, returning `202` with `queued`), `POST /v1/notifications` with event-based routing, HMAC request signing (`X-Client-Id`, `X-Timestamp`, `X-Signature`), XOAUTH2, encrypted per-tenant SMTP credentials stored in a database, and Web Push.

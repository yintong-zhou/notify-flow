# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Skeleton only: every file under `src/` is empty, and `package.json`, `tsconfig.json` and `wrangler.jsonc` are `{}` placeholders. No build, lint, test or dev commands exist yet. Add them here once `package.json` has scripts.

The spec is `notification-service.md`. Read it before implementing anything. `AGENT.md` is a separate document with instructions for an LLM agent that runs inside a serverless backend (directives, tools, runs). It does not describe this service's code, so don't conflate the two.

## What this is

A transactional email service running on Cloudflare Workers (TypeScript). It is meant to be shared by several applications, which call it over REST. It talks SMTP directly and does not use Resend, SendGrid, Mailgun or similar services. Callers are other backends, never frontends.

MVP endpoint: `POST /v1/email/send` with body `{ template, to, locale, variables }`. It responds with `{ id, status }`.

## Architecture

Request flow: `routes/` → `security/` (auth, validation, rate limit) → `services/email-service.ts` → `templates/` (render subject, html and text) → `smtp/` → SMTP server.

- **Templates only.** Callers choose a predefined template and pass variables. They never send a subject or HTML. Each template declares its allowed variables and its locales, and the validation step rejects anything else. This is a core anti-abuse guarantee, not a convenience.
- **Generic SMTP client with presets.** `smtp-client.ts` implements the protocol: EHLO, STARTTLS, AUTH LOGIN and AUTH PLAIN, then MAIL FROM, RCPT TO, DATA and QUIT. It supports both implicit TLS (465) and STARTTLS (587). `gmail.ts`, `microsoft.ts` and `generic.ts` contain configuration presets (host, port, security) and no logic. `provider.ts` selects the preset. The service layer must not depend on a specific provider.
- **Raw TCP.** On Workers, use `connect()` from `cloudflare:sockets`. For STARTTLS, use `secureTransport: "starttls"` together with `socket.startTls()`. Outbound port 25 is blocked on Workers.
- **No auth logic.** The service only delivers mail. Token generation and user checks stay in the calling backend.

## Hard constraints from the spec

- **Auth:** each client gets its own API key, sent as `Authorization: Bearer` or `X-API-Key`. Store keys as hashes, never as plaintext.
- **SMTP credentials:** read them from Cloudflare Secrets (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_AUTH_TYPE`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`). Never put them in code, the repo or logs.
- **Idempotency:** honor the `Idempotency-Key` header, and never send the same message twice.
- **Rate limiting:** limits are configurable per client and per recipient and template. Examples from the spec: 5 password-reset emails per address per hour, and 100 requests per client per minute.
- **Delivery records** (`email_deliveries`) must never contain passwords, plaintext tokens, reset URLs or credentials.
- **Statuses:** `accepted`, `queued`, `processing`, `submitted`, `failed`, `retrying`. Use `submitted` and never `delivered`, because SMTP acceptance does not prove inbox delivery.

## Not in the MVP (spec roadmap)

Cloudflare Queues (API Worker → Queue → Email Worker, returning `202` with `queued`), `POST /v1/notifications` with event-based routing, HMAC request signing (`X-Client-Id`, `X-Timestamp`, `X-Signature`), XOAUTH2, encrypted per-tenant SMTP credentials stored in a database, and Web Push.

# notify-flow

A self-hosted transactional email service for Cloudflare Workers. Your backends call one authenticated REST API, and notify-flow renders the email from a template and sends it over plain SMTP to Gmail, Microsoft 365 or any other SMTP server. It does not depend on Resend, SendGrid, Mailgun or similar platforms.

> [!NOTE]
> The MVP is implemented: emails are sent synchronously, and data lives in Cloudflare D1. The [Roadmap](#roadmap) lists what comes next.

## Why

Every app ends up sending the same emails: welcome, email verification, password reset, login alerts. notify-flow keeps those emails in one place:

- **One integration.** Apps call a REST endpoint instead of each embedding its own SMTP logic and credentials.
- **Templates, not raw HTML.** Callers pick a template and pass variables. They can't send an arbitrary subject or body, which closes off spam and impersonation.
- **Your own templates.** Each client can register its own templates, or override the built-in ones, in `it`, `en` and `pt-BR`.
- **Any SMTP provider.** Gmail and Microsoft 365 are configuration presets on top of a generic SMTP client, not hard dependencies.

## How it works

```text
Frontend ──► Your backend ──► notify-flow (Worker) ──► SMTP server ──► Recipient
                 │                  │
                 │                  ├─ authenticate the client (API key)
                 │                  ├─ validate payload and rate limit
                 │                  ├─ render the template (subject, HTML, text)
                 │                  ├─ send over TLS / STARTTLS, retrying transient errors
                 │                  └─ log the delivery in D1
                 └─ owns auth logic (tokens, reset URLs, user checks)
```

notify-flow only delivers mail. Security logic such as generating reset tokens stays in your backend.

## Getting started

You need Node.js 20+ and a Cloudflare account.

```bash
npm install
npm run db:migrate:local
npm run client:create -- my-app          # prints the API key once
cp .dev.vars.example .dev.vars           # fill in your SMTP credentials
npm run dev
```

To deploy:

```bash
npx wrangler d1 create notify-flow       # copy the database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put SMTP_USERNAME    # repeat for SMTP_PASSWORD, SMTP_FROM_EMAIL, SMTP_FROM_NAME
npm run deploy
npm run client:create -- my-app --remote
```

> [!NOTE]
> Gmail needs an [app password](https://support.google.com/accounts/answer/185833) when 2-step verification is on.

## API

Every `/v1/*` route needs an API key, sent as `Authorization: Bearer <key>` or `X-API-Key: <key>`. Errors always have the shape `{ "error": { "code", "message" } }`.

### Send an email

```http
POST /v1/email/send
Authorization: Bearer <API_KEY>
Idempotency-Key: password-reset:user-123:request-456
Content-Type: application/json

{
  "template": "password-reset",
  "to": "user@example.com",
  "locale": "it",
  "variables": {
    "appName": "Acme",
    "name": "Mario",
    "resetUrl": "https://app.example.com/reset-password?token=..."
  }
}
```

```json
{ "id": "msg_…", "status": "submitted" }
```

How a send is handled:

- **Variables:** they must match the template's declared variables exactly. A missing or extra variable returns `400 invalid_variables`.
- **Locale:** `locale` is optional and defaults to `en`. When a template is missing in the requested locale, `en` is used.
- **Idempotency:** a repeated `Idempotency-Key` returns the original `{ id, status }` and sends nothing.
- **Failures:** if the SMTP server refuses the message, the response is `502 smtp_failed`, and it includes the `id`.

> [!NOTE]
> `submitted` means the SMTP server accepted the message. It does not mean the message reached the inbox, which is why there is no `delivered` status.

### Manage templates

| Method and path | Purpose |
|---|---|
| `GET /v1/templates` | List your templates plus the built-in ones (marked `builtin: true`) |
| `GET /v1/templates/:name/:locale` | Read one template (yours, otherwise the built-in) |
| `PUT /v1/templates/:name/:locale` | Create or update a template: `{ subject, html, text, variables }` |
| `DELETE /v1/templates/:name/:locale` | Delete one of your templates (built-ins can't be deleted) |

Templates use `{{variable}}` placeholders, and every placeholder must be listed in `variables`. Values are HTML-escaped in `html`, and line breaks are stripped in `subject`.

**Built-in templates:**
- `welcome`
- `verify-email`
- `password-reset`
- `password-changed`
- `login-alert`
- `generic-notification`

## SMTP configuration

Credentials are stored as [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), never in the repository or in code.

| Name | Where | Value |
|---|---|---|
| `SMTP_PROVIDER` | `vars` in `wrangler.jsonc` | `gmail`, `microsoft` or `generic` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` | `vars`, optional | Override the preset (`SMTP_SECURITY` is `tls` or `starttls`) |
| `SMTP_AUTH_TYPE` | `vars` | `plain` or `login` |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | secret | SMTP account credentials |
| `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` | secret | Sender identity |

| Preset | Host | Port and security |
|---|---|---|
| `gmail` | `smtp.gmail.com` | `465` with TLS |
| `microsoft` | `smtp.office365.com` | `587` with STARTTLS |
| `generic` | set `SMTP_HOST` | `587` with STARTTLS |

## Security

- **Per-client API keys**, stored only as SHA-256 hashes.
- **Idempotency:** retrying a request with the same `Idempotency-Key` never sends a duplicate email.
- **Rate limits:** 60 requests per minute per client, and `RECIPIENT_LIMIT_PER_HOUR` (default 5) emails per recipient and template.
- **No secrets in logs:** delivery records and logs never contain variables, tokens, reset URLs or SMTP credentials.

## Project structure

```text
src/
├── index.ts       # Worker entry point and router
├── routes/        # email, templates, health
├── security/      # auth, payload validation, rate limiting
├── services/      # email-service: idempotency, retries, delivery log
├── templates/     # renderer + built-in defaults
├── smtp/          # SMTP client + provider presets
└── types/
migrations/        # D1 schema
scripts/           # create-client.mjs
test/              # vitest, runs inside workerd
```

## Roadmap

These items come from the spec and are planned after the MVP:

- Asynchronous sending with Cloudflare Queues (`202 Accepted` with status `queued`)
- Event-based `POST /v1/notifications` endpoint (for example `auth.password_reset`)
- HMAC request signing (`X-Client-Id`, `X-Timestamp`, `X-Signature`)
- OAuth2 / XOAUTH2 for Google Workspace and Microsoft 365
- Encrypted per-tenant SMTP credentials stored in a database
- Web Push notifications

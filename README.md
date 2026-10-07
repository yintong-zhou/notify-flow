# notify-flow

A self-hosted transactional email service for Cloudflare Workers. Your backends call one authenticated REST API, and notify-flow renders the email from a predefined template and sends it over plain SMTP to Gmail, Microsoft 365 or any other SMTP server. It does not depend on Resend, SendGrid, Mailgun or similar platforms.

> [!WARNING]
> **Early stage.** The repository is a project skeleton for now: the source files are empty and there are no build, test or deploy scripts yet. This README describes the target design from [`notification-service.md`](notification-service.md). Each section will be updated as it gets implemented.

## Why

Every app ends up sending the same emails: welcome, email verification, password reset, login alerts. notify-flow keeps those emails in one place:

- **One integration.** Apps call a REST endpoint instead of each embedding its own SMTP logic and credentials.
- **Templates, not raw HTML.** Callers pick a template and pass variables. They can't send an arbitrary subject or body, which closes off spam and impersonation.
- **Any SMTP provider.** Gmail and Microsoft 365 are configuration presets on top of a generic SMTP client, not hard dependencies.

## How it works

```text
Frontend ──► Your backend ──► notify-flow (Worker) ──► SMTP server ──► Recipient
                 │                  │
                 │                  ├─ authenticate the client (API key)
                 │                  ├─ validate payload and rate limit
                 │                  ├─ render the template (subject, HTML, text)
                 │                  └─ send over TLS / STARTTLS
                 └─ owns auth logic (tokens, reset URLs, user checks)
```

notify-flow only delivers mail. Security logic such as generating reset tokens stays in your backend.

## API

```http
POST /v1/email/send
Authorization: Bearer <SERVICE_API_KEY>
Idempotency-Key: password-reset:user-123:request-456
Content-Type: application/json

{
  "template": "password-reset",
  "to": "user@example.com",
  "locale": "en",
  "variables": {
    "name": "Mario",
    "resetUrl": "https://app.example.com/reset-password?token=..."
  }
}
```

```json
{ "id": "msg_123", "status": "accepted" }
```

**Planned templates:** `welcome`, `verify-email`, `password-reset`, `password-changed`, `login-alert` and `generic-notification`.

**Delivery statuses:** `accepted`, `queued`, `processing`, `submitted`, `retrying` and `failed`.

> [!NOTE]
> `submitted` means the SMTP server accepted the message. It does not mean the message reached the inbox, which is why there is no `delivered` status.

## SMTP configuration

Credentials are stored as [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), never in the repository or in code.

| Variable | Example |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` or `587` |
| `SMTP_SECURITY` | `tls` or `starttls` |
| `SMTP_AUTH_TYPE` | `login` or `plain` |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | SMTP account credentials |
| `SMTP_FROM_EMAIL` / `SMTP_FROM_NAME` | Sender identity |

| Provider | Host | Port and security |
|---|---|---|
| Gmail / Google Workspace | `smtp.gmail.com` | `465` with TLS, or `587` with STARTTLS |
| Microsoft 365 | `smtp.office365.com` | `587` with STARTTLS |
| Generic SMTP | your host | `587` with STARTTLS (typical) |

## Security

- **Per-client API keys**, stored as hashes rather than in plaintext.
- **Idempotency:** retrying a request with the same `Idempotency-Key` never sends a duplicate email.
- **Rate limits** per client (for example 100 requests per minute) and per recipient and template (for example 5 password resets per address per hour).
- **No secrets in logs:** delivery records never contain passwords, tokens, reset URLs or SMTP credentials.

## Project structure

```text
src/
├── index.ts       # Worker entry point
├── routes/        # HTTP endpoints (email, health)
├── security/      # auth, payload validation, rate limiting
├── services/      # email-service: orchestrates a send
├── templates/     # renderer + one module per template
├── smtp/          # generic SMTP client + provider presets
└── types/
```

## Roadmap

These items come from the spec and are planned after the MVP:

- Asynchronous sending with Cloudflare Queues (`202 Accepted` with status `queued`)
- Event-based `POST /v1/notifications` endpoint (for example `auth.password_reset`)
- HMAC request signing (`X-Client-Id`, `X-Timestamp`, `X-Signature`)
- OAuth2 / XOAUTH2 for Google Workspace and Microsoft 365
- Encrypted per-tenant SMTP credentials stored in a database
- Web Push notifications

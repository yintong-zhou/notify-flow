# Notification Service MVP — Design

Date: 2026-10-08
Source requirements: [`notification-service.md`](../../../notification-service.md)

## Goal

A single Cloudflare Worker that lets authenticated backends send transactional emails through a direct SMTP connection, using predefined templates. Templates come either from the service's built-in defaults or from templates each client registers over the API. Data lives in Cloudflare D1.

Success: a backend calls `POST /v1/email/send` with an API key, and the email is submitted to the configured SMTP server (Gmail, Microsoft 365 or generic). The send is idempotent and rate limited, and it is recorded in D1 without sensitive data.

## Scope

**In scope:**
- synchronous sending;
- per-client API keys;
- payload validation;
- per-client template management (CRUD) on top of the built-in defaults;
- the `it`, `en` and `pt-BR` locales;
- per-client and per-recipient rate limiting;
- idempotency;
- the delivery log in D1;
- the health endpoint;
- an admin script that creates clients.

**Out of scope:** this is the post-MVP roadmap of the source spec.
- Cloudflare Queues and asynchronous sending
- `POST /v1/notifications`
- HMAC signing
- XOAUTH2
- per-client SMTP accounts and encrypted credentials
- Web Push

## Approach

The service has no runtime dependencies:
- **Routing:** a `switch` on method and path.
- **Validation:** written by hand.
- **SMTP client:** written from scratch on `cloudflare:sockets`.
- **Templates:** `{{var}}` substitution.

The only dependencies are for development: `wrangler`, `typescript`, `vitest` and `@cloudflare/vitest-plugin` (formerly `@cloudflare/vitest-pool-workers`).

## Architecture

```
fetch → index.ts (router, JSON errors)
      → security/auth.ts        API key → client_id
      → routes/{email,templates,health}.ts
      → security/validation.ts, security/rate-limit.ts
      → services/email-service.ts
      → templates/renderer.ts   (client template in D1 → built-in default)
      → smtp/smtp-client.ts     → SMTP server
      → UPDATE email_deliveries
```

| File | Responsibility |
|---|---|
| `src/index.ts` | Worker entry point, router, maps thrown `HttpError`s to JSON |
| `src/routes/email.ts` | `POST /v1/email/send` |
| `src/routes/templates.ts` | Template CRUD |
| `src/routes/health.ts` | `GET /health` |
| `src/security/auth.ts` | Extracts the key from `Authorization: Bearer` or `X-API-Key`, computes its SHA-256 and looks up `clients.key_hash` |
| `src/security/validation.ts` | Validates send payloads and template payloads |
| `src/security/rate-limit.ts` | Rate Limiting binding (per client), D1 count (per recipient and template) |
| `src/services/email-service.ts` | Idempotency → render → SMTP with retry → delivery record |
| `src/templates/renderer.ts` | Template resolution and `{{var}}` rendering |
| `src/templates/defaults.ts` | Built-in templates for `it`, `en` and `pt-BR` |
| `src/smtp/smtp-client.ts` | SMTP protocol plus MIME message building: `sendMail(config, message, connectFn = connect)` |
| `src/smtp/provider.ts` | Presets (`gmail`, `microsoft`, `generic`) and resolution of `SmtpConfig` from env |
| `src/types/index.ts` | `Env` and shared types |
| `migrations/0001_init.sql` | D1 schema |
| `scripts/create-client.mjs` | Creates a client and prints its API key once |

The skeleton files `src/templates/{welcome,verify-email,password-reset,login-alert}.ts` and `src/smtp/{gmail,microsoft,generic}.ts` are deleted. Templates are data, and presets are a single object in `provider.ts`.

## Configuration

| Name | Kind | Notes |
|---|---|---|
| `DB` | D1 binding | Database `notify-flow` |
| `CLIENT_RATE_LIMITER` | Rate Limiting binding | `limit: 60`, `period: 60`, keyed by `client_id` |
| `IP_RATE_LIMITER` | Rate Limiting binding | `limit: 300`, `period: 60`, keyed by `CF-Connecting-IP`, checked before the API key |
| `triggers.crons` | Cron Trigger | `0 3 * * *`: deletes `email_deliveries` rows older than 30 days, 1000 per statement |
| `SMTP_PROVIDER` | var | `gmail`, `microsoft` or `generic`. Selects the default host, port and security. |
| `RECIPIENT_LIMIT_PER_HOUR` | var | Default `5` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` | var, optional (default `""`) | Override the preset. `SMTP_SECURITY` is `tls` or `starttls`. Vars, not secrets: a Worker cannot have a secret and a var with the same name. |
| `SMTP_AUTH_TYPE` | var, optional | `plain` or `login`. Defaults to the preset (`gmail` and `generic` use `plain`, `microsoft` uses `login`, since Microsoft 365 only offers AUTH LOGIN and XOAUTH2). |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | secret | |
| `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` | secret | |

Presets:

| Preset | Host | Port | Security | Auth |
|---|---|---|---|---|
| `gmail` | `smtp.gmail.com` | 465 | `tls` | `plain` |
| `microsoft` | `smtp.office365.com` | 587 | `starttls` | `login` |
| `generic` | — | 587 | `starttls` | `plain` |

The `generic` preset requires `SMTP_HOST`. If no host can be resolved, or the port is 25 (blocked on Workers), the send fails with `500 smtp_misconfigured`.

## Data model (D1)

```sql
CREATE TABLE clients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,   -- hex SHA-256 of the API key
  created_at INTEGER NOT NULL        -- unix seconds
);

CREATE TABLE templates (
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  locale     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  html       TEXT NOT NULL,
  text       TEXT NOT NULL,
  variables  TEXT NOT NULL,          -- JSON array of allowed variable names
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, name, locale)
);

CREATE TABLE email_deliveries (
  id              TEXT PRIMARY KEY,  -- msg_<uuid>
  request_id      TEXT NOT NULL,     -- cf-ray header, or a uuid
  client_id       TEXT NOT NULL REFERENCES clients(id),
  idempotency_key TEXT,
  template        TEXT NOT NULL,
  provider        TEXT NOT NULL,
  recipient       TEXT NOT NULL,     -- lowercased
  status          TEXT NOT NULL CHECK (status IN
                    ('accepted','queued','processing','submitted','failed','retrying')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE (client_id, idempotency_key)
);

CREATE INDEX idx_deliveries_rate ON email_deliveries (client_id, recipient, template, created_at);  -- migration 0002
```

`email_deliveries` never stores variables, rendered content, URLs or tokens.

## Continued

[Part 2](2026-10-08-notification-service-mvp-design-part2.md): templates, API, SMTP client, admin script and testing.

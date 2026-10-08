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
- retention cron

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

## Templates

**Locales:** `it`, `en`, `pt-BR`. The `locale` field in a send request is optional and defaults to `en`.

**Resolution** for (client, name, locale):
1. the client template in that locale;
2. the built-in template in that locale;
3. steps 1 and 2 repeated with `en`;
4. otherwise `404 template_not_found`.

A client can therefore override a single locale of a built-in template.

**Built-in templates**, each available in `it`, `en` and `pt-BR`:

| Name | Variables |
|---|---|
| `welcome` | `appName`, `name` |
| `verify-email` | `appName`, `name`, `verifyUrl` |
| `password-reset` | `appName`, `name`, `resetUrl` |
| `password-changed` | `appName`, `name` |
| `login-alert` | `appName`, `name`, `device`, `ipAddress`, `time` |
| `generic-notification` | `appName`, `title`, `message` |

**Variables:** the variables sent must match the template's `variables` set exactly (same keys, all of them strings). A missing or extra variable returns `400 invalid_variables`.

**Rendering** happens in a single pass with `/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g`, so substituted values are never expanded again:
- **`html`:** values have `& < > " '` HTML-escaped.
- **`subject`:** values have `\r` and `\n` removed, and the result is trimmed.
- **`text`:** values are inserted as is.

**Template validation** on `PUT`:
- `name` must match `^[a-z0-9-]{1,64}$`;
- `locale` must be one of the supported locales;
- `subject` is 1 to 255 characters, `html` at most 100 KB, `text` at most 50 KB;
- `variables` is an array of strings, each matching `^[a-zA-Z0-9_]{1,64}$`;
- every placeholder used in `subject`, `html` or `text` must be declared in `variables`.

## API

Every `/v1/*` route requires an API key, otherwise it returns `401 unauthorized`. Errors use the shape `{ "error": { "code": string, "message": string } }`.

| Method and path | Request | Success |
|---|---|---|
| `GET /health` | — | `200 {"status":"ok"}` |
| `POST /v1/email/send` | `{template, to, locale?, variables}`, optional `Idempotency-Key` header (at most 255 characters) | `200 {id, status:"submitted"}` |
| `GET /v1/templates` | — | `200 [{name, locale, builtin, updated_at}]`: the client's templates plus the built-in defaults, with `updated_at` set to `null` for built-ins. When a client template overrides a built-in for the same name and locale, only the client template is listed. |
| `GET /v1/templates/:name/:locale` | — | `200 {name, locale, subject, html, text, variables, builtin}`. Uses the client template if it exists, otherwise the built-in one, and returns `404` otherwise. |
| `PUT /v1/templates/:name/:locale` | `{subject, html, text, variables}` | `200` with the stored template |
| `DELETE /v1/templates/:name/:locale` | — | `204`. Returns `404` if the client has no such template. Built-in templates cannot be deleted. |

Other codes:
- `400 invalid_json`, `400 validation_error` (with field details in `message`), `400 invalid_variables`;
- `404 not_found` for unknown routes;
- `405 method_not_allowed`;
- `413 payload_too_large` when the body exceeds 256 KB;
- `429 rate_limited`;
- `502 smtp_failed` (which includes `id` in the body);
- `500 internal_error`.

### Send flow

1. Authenticate the key to get the `client_id`.
2. Check the client rate limit (`CLIENT_RATE_LIMITER.limit({ key: client_id })`), or return `429`. This check applies to every `/v1/*` route, not only to sends.
3. Validate the payload:
   - `to` is a single address of at most 254 characters, with no CR, LF or comma, matching `^[^\s@]+@[^\s@]+\.[^\s@]+$`;
   - `template` follows the name rule;
   - `locale` is supported;
   - `variables` is an object of strings.
4. Resolve the template and check that the variables match.
5. Check the recipient rate limit. An idempotent replay (a known `Idempotency-Key`) is answered with the original `{id, status}` before this step, so it is never rate limited:
   ```sql
   SELECT COUNT(*) FROM email_deliveries
   WHERE client_id = ? AND recipient = ? AND template = ? AND status != 'failed' AND created_at > unixepoch() - 3600
   ```
   Return `429` if the count is at least `RECIPIENT_LIMIT_PER_HOUR`.
6. `INSERT` the delivery row with status `processing`. If the `UNIQUE (client_id, idempotency_key)` constraint fails, return the existing row's `{id, status}` with `200` and send nothing. This holds even when the existing status is `failed`: the client retries with a new key.
7. Render the template and send through SMTP with retries.
8. `UPDATE` the row to `submitted` (setting `sent_at` and `attempts`), or to `failed` (setting `error_code` and `attempts`). Steps 6-8 run under `ctx.waitUntil`, so they finish even if the caller disconnects. If a row is still `processing` more than 300 s after creation, a replay closes it as `failed` with `error_code = 'abandoned'`. The email may or may not have gone out.

## SMTP client

`sendMail(config, message, connectFn = connect)`, where `connect` comes from `cloudflare:sockets`.

**Connection:**
- `tls` uses `connect({hostname, port}, {secureTransport: "on"})`.
- `starttls` uses `secureTransport: "starttls"`. After `EHLO` and a `220` reply to `STARTTLS`, the client calls `socket.startTls()` and sends a second `EHLO`.

**Session:**
- **Greeting:** wait for `220`, then send `EHLO <domain of from address>`.
- **Replies:** multiline replies (`250-…` lines followed by `250 …`) are read up to the final line.
- **Authentication:**
  - `AUTH PLAIN base64("\0user\0pass")`, expecting `235`;
  - or `AUTH LOGIN`, expecting `334`, then `base64(user)` expecting `334`, then `base64(pass)` expecting `235`.
- **Envelope:** `MAIL FROM:<from>` expecting `250`, `RCPT TO:<to>` expecting `250`/`251`, `DATA` expecting `354`.
- **Message:** the message with dot-stuffing and CRLF line endings, terminated by `.` and expecting `250`.
- **Close:** `QUIT`, then close the socket.
- **Timeout:** each command times out after 10 seconds.

**MIME message:**

```
From: =?UTF-8?B?<name>?= <from>
To: <to>
Subject: =?UTF-8?B?<subject>?=
Date: <RFC 5322 date>
Message-ID: <msg_id@from-domain>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="<random>"
```

It contains a `text/plain` part and a `text/html` part, both `charset=UTF-8` with `Content-Transfer-Encoding: base64`, wrapped at 76 characters.

**Errors** are thrown as `SmtpError { code, transient }`:

| Situation | `code` | `transient` |
|---|---|---|
| Connect or socket failure | `smtp_connection_failed` | yes |
| Command timeout | `smtp_timeout` | yes |
| `4xx` reply | `smtp_temporary_failure` | yes |
| `5xx` reply to `AUTH` | `smtp_auth_failed` | no |
| Any other `5xx` reply | `smtp_rejected` | no |

**Retry** happens in `email-service`: at most 3 attempts, only for transient errors, with backoff delays of 500 ms and then 1000 ms.

**Logging:** `console.error` only logs `{id, client_id, error_code}`. It never logs the recipient, variables, credentials or raw SMTP replies.

## Admin script

`node scripts/create-client.mjs <name> [--remote]`:
1. generates a key `nf_<32 random bytes, base64url>`;
2. computes its SHA-256 in hex;
3. runs `wrangler d1 execute notify-flow [--local|--remote] --command "INSERT INTO clients …"`;
4. prints the key once.

The key is never stored in plaintext.

## Testing

`vitest` with `@cloudflare/vitest-plugin`, running inside `workerd` with a local D1 and the migrations applied in test setup.

- **`test/renderer.test.ts`:** escaping, CRLF stripping, no re-expansion, variable mismatch, and the resolution order (client → built-in → `en`).
- **`test/smtp-client.test.ts`:** a scripted fake server built on stream pairs and passed as `connectFn`. It covers:
  - the command sequence for `tls`;
  - the `STARTTLS` upgrade;
  - `AUTH PLAIN` and `AUTH LOGIN`;
  - dot-stuffing;
  - the `SmtpError` classification for `4xx` and `5xx` replies.
- **`test/api.test.ts`:** `SELF.fetch` with `smtp-client` mocked. It covers:
  - `401` without a key;
  - template CRUD and isolation between clients;
  - a successful send that writes the D1 row;
  - an idempotent replay that does not send a second time;
  - `429` once the per-recipient limit is reached;
  - a transient SMTP error that is retried and then succeeds;
  - a permanent SMTP error that marks the row `failed` and returns `502`.

**Scripts:**

| Script | Command |
|---|---|
| `dev` | `wrangler dev` |
| `deploy` | `wrangler deploy` |
| `test` | `vitest run` |
| `typecheck` | `tsc --noEmit` |
| `db:migrate:local` / `db:migrate:remote` | `wrangler d1 migrations apply notify-flow --local` / `--remote` |
| `client:create` | `node scripts/create-client.mjs` |

Real delivery to Gmail or Microsoft 365 requires the user's credentials. It is verified manually with `wrangler secret put …` and `wrangler dev --remote`.

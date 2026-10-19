# Notify Flow

A self-hosted transactional email service for Cloudflare Workers. Your backends call one authenticated REST API, and notify-flow renders the email from a template and sends it over plain SMTP to Gmail, Microsoft 365 or any other SMTP server. It does not depend on Resend, SendGrid, Mailgun or similar platforms.

> [!NOTE]
> The MVP is implemented: emails are sent by template name or by event, synchronously or asynchronously through Cloudflare Queues, and data lives in Cloudflare D1. The [Roadmap](#roadmap) lists what comes next.

> [!TIP]
> Adding email to your web app? Follow the **[web app integration guide](docs/web-app-integration.md)**: a step-by-step walkthrough with backend code samples. Or paste the **[AI integration prompt](docs/ai-integration-prompt.md)** into a coding agent and let it do the work, then the **[AI management page prompt](docs/ai-management-page-prompt.md)** to get an admin page with statistics and template editing.

## Why

<!-- #region why -->
Every app ends up sending the same emails: welcome, email verification, password reset, login alerts. notify-flow keeps those emails in one place:

- **One integration.** Apps call a REST endpoint instead of each embedding its own SMTP logic and credentials.
- **Templates, not raw HTML.** Callers pick a template and pass variables. They can't send an arbitrary subject or body, which closes off spam and impersonation.
- **Your own templates.** Each client can register its own templates, or override the built-in ones, in `it`, `en` and `pt-BR`.
- **Any SMTP provider.** Gmail and Microsoft 365 are configuration presets on top of a generic SMTP client, not hard dependencies.
<!-- #endregion why -->

## How it works

<!-- #region how-it-works -->
```text
Frontend ──► Your backend ──► notify-flow (Worker) ──► SMTP server ──► Recipient
                 │                  │
                 │                  ├─ authenticate the client (API key)
                 │                  ├─ validate payload and rate limit
                 │                  ├─ pick the template (by name or event), render subject, HTML, text
                 │                  ├─ send over TLS / STARTTLS, now or from a queue, retrying transient errors
                 │                  └─ log the delivery in D1
                 └─ owns auth logic (tokens, reset URLs, user checks)
```

notify-flow only delivers mail. Security logic such as generating reset tokens stays in your backend.
<!-- #endregion how-it-works -->

## Getting started

<!-- #region getting-started -->
You need Node.js 20+ and a Cloudflare account.

```bash
npm install
cp wrangler.jsonc.example wrangler.jsonc # git-ignored: fill in your database_id before deploying
npm run db:migrate:local
npm run client:create -- my-app          # prints the API key once
cp .dev.vars.example .dev.vars           # fill in your SMTP credentials
npm run dev                              # admin dashboard: http://localhost:8787/admin/ (not 127.0.0.1)
```

To deploy:

```bash
npx wrangler d1 create notify-flow       # copy the database_id into wrangler.jsonc
npm run db:migrate:remote                # on upgrades too: migrate before npm run deploy
npx wrangler queues create notify-flow-emails  # once: the async send queue
npx wrangler secret put SMTP_USERNAME    # repeat for SMTP_PASSWORD, SMTP_FROM_EMAIL, SMTP_FROM_NAME
npx wrangler secret put ADMIN_SETUP_TOKEN  # long random string, used once to register the /admin account
npm run deploy
npm run client:create -- my-app --remote
```

> [!NOTE]
> Gmail needs an [app password](https://support.google.com/accounts/answer/185833) when 2-step verification is on.

For development:

```bash
npm test                                 # vitest inside workerd, with a local D1
npm run typecheck                        # regenerates worker types, then tsc
```
<!-- #endregion getting-started -->

## Integrate it into your web app

A web app sends email in three steps:

1. **Get an API key.** Run `npm run client:create -- <app-name> --remote` once per app, then store the key as a secret in the app's backend.
2. **Call the API from the backend.** Send `POST /v1/email/send` with a template, a recipient and the template's variables, or `POST /v1/notifications` with an event instead of a template. The frontend never calls notify-flow.
3. **Handle the result.** Retry network errors, `429` and `500` with the same `Idempotency-Key`. Treat `4xx` as integration bugs.

The **[web app integration guide](docs/web-app-integration.md)** covers the details: architecture, Node.js and Python clients, password reset and sign-up flows, custom templates, retry rules, [asynchronous sending](docs/web-app-integration-async.md) and a production checklist.

## Admin dashboard

The Worker also serves a monitoring page at `/admin/`: delivery stats and search, a log of errors and rejected requests, and a SQL console on the D1 database. There is one admin account, registered on the first visit with the `ADMIN_SETUP_TOKEN` secret and kept separate from client API keys. The **[admin dashboard guide](docs/admin-dashboard.md)** covers setup, upgrades of an existing deployment, and what each section shows.

## API

Every `/v1/*` route needs an API key, sent as `Authorization: Bearer <key>` or `X-API-Key: <key>`. A send is one call:

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

The **[API Reference](docs/api-reference.md)** documents every endpoint, field rule, error code and status: [sending](docs/api-reference-email.md), and [events, templates and health](docs/api-reference-config.md).

## SMTP configuration

<!-- #region smtp-configuration -->
Credentials are stored as [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), never in the repository or in code.

| Name | Where | Value |
|---|---|---|
| `SMTP_PROVIDER` | `vars` in `wrangler.jsonc` | `gmail`, `microsoft` or `generic` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` | `vars`, optional | Override the preset (`SMTP_SECURITY` is `tls` or `starttls`) |
| `SMTP_AUTH_TYPE` | `vars`, optional | `plain` or `login` (default: per preset) |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | secret | SMTP account credentials |
| `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` | secret | Sender identity |

| Preset | Host | Port, security and auth |
|---|---|---|
| `gmail` | `smtp.gmail.com` | `465` with TLS, AUTH PLAIN |
| `microsoft` | `smtp.office365.com` | `587` with STARTTLS, AUTH LOGIN |
| `generic` | set `SMTP_HOST` | `587` with STARTTLS, AUTH PLAIN |

> [!WARNING]
> Microsoft 365 requires SMTP AUTH to be enabled on the sending mailbox, and Security Defaults block it. Microsoft is also retiring basic authentication for SMTP AUTH. If you use this preset, plan for OAuth2 (XOAUTH2 is on the roadmap).
<!-- #endregion smtp-configuration -->

## Security

<!-- #region security -->
- **Per-client API keys**, stored only as SHA-256 hashes.
- **Idempotency:** retrying a request with the same `Idempotency-Key` never sends a duplicate email.
- **Rate limits:** 300 requests per minute per IP (checked before the API key), 60 per minute per client, and `RECIPIENT_LIMIT_PER_HOUR` (default 5) emails per recipient and template for each client. Failed sends do not count.
- **No secrets in logs:** delivery records and logs never contain variables, tokens, reset URLs or SMTP credentials.
<!-- #endregion security -->

## Project structure

```text
src/
├── index.ts       # Worker entry point and router
├── admin/         # dashboard API: setup, login, sessions, stats, logs, SQL
├── routes/        # email, notifications, events, templates, health
├── security/      # auth, payload validation, rate limiting
├── services/      # email-service (idempotency, retries, delivery log), queue-consumer (async sends), logger (app_logs)
├── templates/     # renderer, built-in defaults, built-in events
├── smtp/          # SMTP client + provider presets
└── types/
public/admin/      # dashboard pages, served as static assets
migrations/        # D1 schema
scripts/           # create-client.mjs
test/              # vitest, runs inside workerd
docs/              # docs site (VitePress): guides, API Reference; specs and plans are not published
```

## Docs site

The `docs/` folder doubles as a [VitePress](https://vitepress.dev) site: Home, Documentation and API Reference, built from these Markdown files (specs, plans and handoffs are not published).

```bash
npm run docs:dev                         # local site with hot reload
npm run docs:build                       # static build in docs/.vitepress/dist; fails on dead links
npm run docs:preview                     # serve the build
```

To publish it, connect the repository to [Cloudflare Pages](https://developers.cloudflare.com/pages/configuration/git-integration/) with these settings:

| Setting | Value |
|---|---|
| Project name | `notify-flow-docs` |
| Production branch | `main` |
| Build command | `npm run docs:build` |
| Build output directory | `docs/.vitepress/dist` |
| Environment variable | `NODE_VERSION=22` |

## Roadmap

These items come from the spec and are planned after the MVP:

- HMAC request signing (`X-Client-Id`, `X-Timestamp`, `X-Signature`)
- OAuth2 / XOAUTH2 for Google Workspace and Microsoft 365
- Encrypted per-tenant SMTP credentials stored in a database
- Web Push notifications

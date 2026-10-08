# Integrating notify-flow into a web app

This guide shows how a web app's backend sends transactional emails through notify-flow. To set up and deploy the service itself, see the [README](../README.md). Part 2 covers [flows, templates, retries and production](web-app-integration-flows.md).

## Overview

To send a transactional email, your web app's backend makes one HTTP call to notify-flow, with a template name and its variables. notify-flow does the rest and returns a delivery id.

| notify-flow handles | Your web app handles |
| --- | --- |
| Authenticating your app with its API key | Deciding when to send (sign-up, password reset, login…) |
| Picking the template and locale, rendering subject, HTML and text | Generating tokens and links (verification, reset) and checking them |
| Sending over SMTP (Gmail, Microsoft 365 or generic SMTP), with retries | Keeping the API key in the backend only |
| Rate limiting and idempotency | Handling the result of the call (errors, retries) |
| Logging the delivery outcome | Showing the user a neutral message |

notify-flow only delivers email: it doesn't know your users and doesn't handle passwords or tokens.

## Prerequisites

The notify-flow administrator gives each web app a URL and its own API key. Both go in the web app's backend, never in the frontend.

| What | Value | Where it goes |
| --- | --- | --- |
| Service URL | `https://notify-flow.<your-subdomain>.workers.dev` | Backend environment variable, e.g. `NOTIFY_FLOW_URL` |
| API key | `nf_…`, shown once when it is created | Backend secret, e.g. `NOTIFY_FLOW_API_KEY` |
| App name | Free text, e.g. `Acme` | Sent with every email as the `appName` variable |

The administrator creates the key with `npm run client:create -- <app-name> --remote`. Use one key per web app: you can revoke one without touching the others, and each app gets its own templates and limits.

If the key ends up in the frontend, in a repository or in a chat, treat it as compromised: ask the administrator to create a new one and delete the old one.

## Architecture

The frontend never talks to notify-flow. It asks your app's backend for an action, and the backend calls notify-flow with the API key.

```text
┌──────────────────────────────────────────────────────────┐
│ Frontend (browser or mobile app)                         │
│ Asks for an action: sign-up, password reset, login.      │
│ Doesn't know the API key and never calls notify-flow.    │
└──────────────────────────────────────────────────────────┘
                             │  POST /forgot-password
                             ▼  (no API key)
┌──────────────────────────────────────────────────────────┐
│ Your web app's backend               ◄── you build this  │
│ Checks the user, generates tokens and links.             │
│ Holds the API key and calls notify-flow.                 │
└──────────────────────────────────────────────────────────┘
                             │  POST /v1/email/send with key and Idempotency-Key
                             ▼  response: id and status
┌──────────────────────────────────────────────────────────┐
│ notify-flow (Cloudflare Worker)                          │
│ Authenticates, validates, applies limits and idempotency.│
│ Renders the template, sends with retries, logs to D1.    │
└──────────────────────────────────────────────────────────┘
                             │
                             ▼  SMTP over TLS (465) or STARTTLS (587)
┌──────────────────────────────────────────────────────────┐
│ SMTP server (Gmail, Microsoft 365 or other)              │
│ Accepts the message: the delivery becomes submitted.     │
└──────────────────────────────────────────────────────────┘
                             │
                             ▼  delivery
┌──────────────────────────────────────────────────────────┐
│ The user's inbox                                         │
└──────────────────────────────────────────────────────────┘
```

The backend box is the part you build. Everything below it is handled by notify-flow.

## Sending an email

Every send is a `POST /v1/email/send`. On success it returns `200` with `{"id":"msg_…","status":"submitted"}`.

```bash
curl -X POST "$NOTIFY_FLOW_URL/v1/email/send" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: password-reset:user-123:req-456" \
  -d '{
    "template": "password-reset",
    "to": "jane.doe@example.com",
    "locale": "en",
    "variables": {
      "appName": "Acme",
      "name": "Jane",
      "resetUrl": "https://app.acme.com/reset?token=..."
    }
  }'
```

| Field | Required | Rules |
| --- | --- | --- |
| `template` | yes | Template name: lowercase letters, digits and hyphens, at most 64 characters |
| `to` | yes | A single address, at most 254 characters, no commas or line breaks |
| `locale` | no | `it`, `en` or `pt-BR`. Default: `en` |
| `variables` | yes | An object of strings only, with exactly the variables the template declares |
| `Authorization` header | yes | `Bearer <key>`, or the `X-API-Key: <key>` header instead |
| `Idempotency-Key` header | recommended | 1 to 255 characters, unique per user action |

`submitted` means the SMTP server accepted the message, not that it reached the recipient's inbox.

| HTTP status | `error.code` | What to do |
| --- | --- | --- |
| 200 | — | Sent, or a replayed answer for the same `Idempotency-Key` |
| 400 | `validation_error`, `invalid_json`, `invalid_variables` | Fix the payload: retrying won't help |
| 401 | `unauthorized` | Missing or wrong key: check your configuration |
| 404 | `template_not_found` | The template exists neither in that locale nor in `en` |
| 413 | `payload_too_large` | The body is over 256 KB |
| 429 | `rate_limited` | Too many requests: retry later |
| 500 | `smtp_misconfigured`, `internal_error` | A problem on the service side: tell the administrator |
| 502 | `smtp_failed` | The SMTP server refused the message after retries, or never confirmed it (the message then says it may still be delivered). The response includes the delivery `id` |

Errors always have the shape `{"error":{"code":"…","message":"…"}}`.

## Backend code examples

All you need is one function that makes the `POST` and turns errors into exceptions. No library required: `fetch` in Node 18+, `requests` in Python.

Node.js / TypeScript:

```typescript
const NOTIFY_URL = process.env.NOTIFY_FLOW_URL!;      // https://notify-flow.<your-subdomain>.workers.dev
const NOTIFY_KEY = process.env.NOTIFY_FLOW_API_KEY!;  // nf_...

export async function sendEmail(opts: {
  template: string;
  to: string;
  variables: Record<string, string>;
  locale?: "it" | "en" | "pt-BR";
  idempotencyKey?: string;
}): Promise<{ id: string; status: string }> {
  const res = await fetch(`${NOTIFY_URL}/v1/email/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTIFY_KEY}`,
      "Content-Type": "application/json",
      ...(opts.idempotencyKey && { "Idempotency-Key": opts.idempotencyKey }),
    },
    body: JSON.stringify({
      template: opts.template,
      to: opts.to,
      locale: opts.locale ?? "en",
      variables: { appName: "Acme", ...opts.variables },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`notify-flow ${res.status} ${body.error?.code}`);
  return body;
}
```

Python:

```python
import os, requests

NOTIFY_URL = os.environ["NOTIFY_FLOW_URL"]
NOTIFY_KEY = os.environ["NOTIFY_FLOW_API_KEY"]

def send_email(template, to, variables, locale="en", idempotency_key=None):
    headers = {"Authorization": f"Bearer {NOTIFY_KEY}"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    res = requests.post(
        f"{NOTIFY_URL}/v1/email/send",
        json={"template": template, "to": to, "locale": locale,
              "variables": {"appName": "Acme", **variables}},
        headers=headers,
        timeout=30,
    )
    body = res.json()
    if not res.ok:
        raise RuntimeError(f"notify-flow {res.status_code} {body['error']['code']}")
    return body
```

The 30-second timeout is there because notify-flow retries transient SMTP errors before answering, so a slow response is normal.

## Next

Continue with [flows, custom templates, retries, security and the production checklist](web-app-integration-flows.md).

# API Reference

The full contract of the notify-flow REST API. For a guided walkthrough with code samples, see the [integration guide](web-app-integration.md). Endpoints: [sending](api-reference-email.md), and [events, templates and health](api-reference-config.md).

## Base URL

The URL of your deployed Worker, for example `https://notify-flow.<account>.workers.dev`. Every API route lives under `/v1/`; `/health` is the only route outside it.

## Authentication

Every `/v1/*` route needs the API key of a client (one per app, created with `npm run client:create`):

```http
Authorization: Bearer <API_KEY>
```

or `X-API-Key: <API_KEY>`. When the `Authorization` header starts with `Bearer `, it wins over `X-API-Key`.

| Case | Answer |
|---|---|
| No key | `401 unauthorized`, "Missing API key" |
| Unknown key, or longer than 128 characters | `401 unauthorized`, "Invalid API key" |

`/health` needs no key.

## Order of checks

Every `/v1/*` request goes through these checks in order, and the first one that fails answers:

1. Rate limit per IP (`429`)
2. API key (`401`)
3. Rate limit per client (`429`)
4. Route and method (`404`, `405`)
5. `Idempotency-Key` header (`400`)
6. Body (`413`, `400`)

So a wrong method without a key answers `401`, not `405`. Paths outside `/v1/` other than `/health` answer `404 not_found` before any check.

## Request body

`POST` and `PUT` bodies are a JSON object (`Content-Type: application/json`) of at most 256 KB.

| Case | Answer |
|---|---|
| Larger than 256 KB | `413 payload_too_large` |
| Not valid JSON | `400 invalid_json` |
| Valid JSON but not an object | `400 validation_error` |

## Idempotency

Send `Idempotency-Key: <key>` on `POST /v1/email/send` and `POST /v1/notifications` so that a retry never sends a second email.

- **Format:** 1 to 255 characters, checked before the body is read (`400 validation_error`).
- **Scope:** per client, shared by both send endpoints: a key used on one replays its result on the other.
- **Replay:** the same key returns the stored `{ "id", "status" }` without sending, with `200` (or `202` when async), even when `status` is `failed`. Replays are answered before the per-recipient limit.
- **Checked first:** the request is validated, and the template and its variables are checked before the replay lookup. If the template was deleted or its variables changed since the first request, a retry answers that error (`404 template_not_found`, `400 invalid_variables`) instead of the stored result; a broken SMTP configuration answers `500 smtp_misconfigured`. Nothing is ever sent twice.
- **Interrupted send:** a replay of a delivery that has been `processing` for more than 5 minutes closes it as `failed` with `error_code: "abandoned"`. The email may have gone out anyway.
- **No key:** every call sends an email.

## Asynchronous sending

Add `Prefer: respond-async` to a send. The preference name is case-insensitive, and the header may list other preferences too.

- **Answer:** `202 {"id":"msg_…","status":"queued"}` with the header `Preference-Applied: respond-async`. Read the outcome with [`GET /v1/email/:id`](api-reference-email.md#get-v1-email-id).
- **Attempts:** up to 5, the retries coming after 1, 5, 15 and 30 minutes.
- **Size:** the variables must fit in a queue message: over 120 KB answers `413 payload_too_large`.
- **Queue down:** `503 queue_unavailable`, with the delivery `id`. The delivery stays `queued`; retry later with the same `Idempotency-Key`.

## Rate limits

| Limit | Scope | Default |
|---|---|---|
| Requests per IP | every `/v1/*` route, before the API key | 300 per 60 s |
| Requests per client | every `/v1/*` route | 60 per 60 s |
| Emails per recipient | per client, recipient and template, per hour; failed sends don't count | `RECIPIENT_LIMIT_PER_HOUR`, 5 |

All three answer `429 rate_limited`. The administrator sets them in `wrangler.jsonc`.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "template_not_found", "message": "Template \"welcome\" not found" } }
```

`502` and `503` also carry the delivery id at the top level: `{ "error": { … }, "id": "msg_…" }`.

| Status | Code | When |
|---|---|---|
| 400 | `invalid_json` | The body is not valid JSON |
| 400 | `validation_error` | A field, a path parameter or the `Idempotency-Key` breaks its rule. The message names it |
| 400 | `invalid_variables` | The variables don't match the template's list. The message lists `missing` and `unexpected` names |
| 401 | `unauthorized` | Missing or invalid API key |
| 404 | `not_found` | Unknown route, or an email id that is unknown or belongs to another client |
| 404 | `template_not_found` | The template exists neither in the locale nor in `en`. On `PUT /v1/events/:event`: in no locale |
| 404 | `event_not_found` | No mapping of yours and no built-in for the event |
| 405 | `method_not_allowed` | The message lists the allowed methods |
| 413 | `payload_too_large` | Body over 256 KB, or async variables over 120 KB |
| 429 | `rate_limited` | One of the [rate limits](#rate-limits) |
| 500 | `smtp_misconfigured` | The SMTP vars or secrets are missing or invalid: tell the administrator |
| 500 | `internal_error` | An unexpected error |
| 502 | `smtp_failed` | The SMTP server refused the message, or never confirmed it (the message then says it may still be delivered). Temporary failures are retried, up to 3 attempts 0.5 s and 1 s apart; permanent refusals fail at once. Carries `id` |
| 503 | `queue_unavailable` | Async only: the message may not have reached the queue. Carries `id`; retry with the same `Idempotency-Key` |

## Delivery statuses

`GET /v1/email/:id` returns one of these, with an `error_code` when it is `failed`.

| `status` | Meaning |
| --- | --- |
| `queued` | Accepted, waiting for its first attempt |
| `processing` | An SMTP attempt is running |
| `retrying` | A temporary failure: the next attempt comes after 1, 5, 15 or 30 minutes |
| `submitted` | The SMTP server accepted the message (not proof of inbox delivery) |
| `failed` | Final. `error_code` says why |

| `error_code` | Meaning |
| --- | --- |
| `smtp_rejected`, `smtp_auth_failed` | The SMTP server refused the message or the credentials |
| `smtp_timeout`, `smtp_temporary_failure`, `smtp_connection_failed` | Every attempt hit a temporary failure (3 when sync, 5 when async) |
| `smtp_unconfirmed` | The server never confirmed the message: it may still be delivered, so it is not retried |
| `template_not_found`, `invalid_variables` | The template was deleted or changed after the request |
| `abandoned` | The send was interrupted, or a request that got `503` was never retried and expired after 24 hours. The email may or may not have gone out |
| `internal_error` | An unexpected error during the send |

`accepted` also exists in the database schema, but no code path writes it today: it is reserved. There is no `delivered` status, because SMTP acceptance does not prove inbox delivery.

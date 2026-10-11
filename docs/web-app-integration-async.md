# Integrating notify-flow — asynchronous sending

Part of the [web app integration guide](web-app-integration.md).

## When to use it

By default `POST /v1/email/send` holds the request open for the whole SMTP session and answers `200 submitted` or `502 smtp_failed`. Ask for asynchronous sending when:
- **Speed matters:** the backend gets `202` right away, without waiting for the SMTP server.
- **The email must survive an SMTP outage:** the service retries a temporary failure up to 5 times over about 50 minutes, instead of answering `502`.

## Request

The same call, with one extra header: `Prefer: respond-async`.

```bash
curl -X POST "$NOTIFY_FLOW_URL/v1/email/send" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: respond-async" \
  -H "Idempotency-Key: welcome:user-123" \
  -d '{"template":"welcome","to":"jane.doe@example.com","variables":{"appName":"Acme","name":"Jane"}}'
```

Validation, the template check, idempotency and the per-recipient limit all run before the answer, exactly as in the synchronous call. A `400`, `404` or `429` therefore still arrives right away.

## Response

```json
{ "id": "msg_…", "status": "queued" }
```

- **Status code:** `202 Accepted`, with the header `Preference-Applied: respond-async`.
- **Replays:** repeating the same `Idempotency-Key` answers `202` with the current status (for example `submitted`) and sends nothing.

## Reading the outcome

`GET /v1/email/:id`, with the same API key:

```json
{ "id": "msg_…", "status": "submitted", "error_code": null }
```

- **Unknown ids:** an unknown id, or an id that belongs to another app, answers `404 not_found`.
- **Rate limit:** polling counts against the same per-client limit (60 requests per minute), so poll only when you need the answer, for example when the user opens a "resend email" page.

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
| `smtp_timeout`, `smtp_temporary_failure`, `smtp_connection_failed` | All 5 attempts hit a temporary failure |
| `smtp_unconfirmed` | The server never confirmed the message: it may still be delivered, so it is not retried |
| `template_not_found`, `invalid_variables` | The template was deleted or changed after the request |
| `enqueue_failed` | The queue was unavailable when you sent the request (you also got a `503`) |
| `abandoned` | The send was interrupted. The email may or may not have gone out |

## New errors

| HTTP status | `error.code` | What to do |
| --- | --- | --- |
| 413 | `payload_too_large` | The variables are over 120 KB, the queue's limit: shorten them or send synchronously |
| 503 | `queue_unavailable` | Nothing was queued and the delivery is `failed`. Retry later with a new `Idempotency-Key`, because the old one now replays `failed`. The failed attempt does not count against the recipient limit |

## Good to know

- **Templates:** the template is rendered when the email is sent. If you edit it in the meantime, the new version goes out.
- **Variables in transit:** they wait in the queue until the email is sent. Cloudflare encrypts them at rest and deletes them on delivery. They are never written to the delivery log.
- **Mixing modes:** a synchronous call that reuses an async `Idempotency-Key` gets the stored result (`200`, for example `queued`) and sends nothing.

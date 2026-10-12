# Sending

Part of the [API Reference](api-reference.md), which covers authentication, [idempotency](api-reference.md#idempotency), [async sending](api-reference.md#asynchronous-sending) and the full [error table](api-reference.md#errors).

## POST /v1/email/send

Sends an email from a template, now or (with `Prefer: respond-async`) through the queue.

**Headers:** `Authorization` or `X-API-Key`, `Content-Type: application/json`, `Idempotency-Key` (recommended), `Prefer: respond-async` (optional).

| Field | Required | Rule |
|---|---|---|
| `template` | yes | `^[a-z0-9-]{1,64}$` |
| `to` | yes | One address, at most 254 characters, printable ASCII only (no accented or IDN addresses). No spaces, commas, line breaks or `<>()[]\;:@"` outside the single `@`, and a dot in the domain. Stored lowercased |
| `locale` | no | `it`, `en` or `pt-BR`. Default `en` |
| `variables` | yes | An object of strings whose keys are exactly the template's declared variables |

**Template lookup:** your template in `locale`, then the built-in in `locale`, then the same two in `en`. None found → `404 template_not_found`.

**Responses:**

| Status | Body |
|---|---|
| `200` | `{"id":"msg_…","status":"submitted"}`: the SMTP server accepted the message. A replayed `Idempotency-Key` returns the stored `id` and `status` instead |
| `202` | `{"id":"msg_…","status":"queued"}`, async only |
| `502` | `smtp_failed`, with `id`. If the server never confirmed the message, the message says it may still be delivered |

**Errors:** `400 validation_error`, `invalid_json` or `invalid_variables`; `404 template_not_found`; `413`; `429`; `500 smtp_misconfigured`; `502 smtp_failed`; `503 queue_unavailable` (async). See [Errors](api-reference.md#errors).

```bash
curl -X POST "$NOTIFY_FLOW_URL/v1/email/send" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: password-reset:user-123:req-456" \
  -d '{
    "template": "password-reset",
    "to": "jane.doe@example.com",
    "locale": "en",
    "variables": { "appName": "Acme", "name": "Jane", "resetUrl": "https://app.acme.com/reset?token=..." }
  }'
```

### Built-in templates

| Template | Variables |
|---|---|
| `welcome` | `appName`, `name` |
| `verify-email` | `appName`, `name`, `verifyUrl` |
| `password-reset` | `appName`, `name`, `resetUrl` |
| `password-changed` | `appName`, `name` |
| `login-alert` | `appName`, `name`, `device`, `ipAddress`, `time` |
| `generic-notification` | `appName`, `title`, `message` |

All exist in `it`, `en` and `pt-BR`. Override one with [`PUT /v1/templates/:name/:locale`](api-reference-config.md#put-v1-templates-name-locale).

## GET /v1/email/:id

Returns the status of one of your deliveries.

**Path:** `id` is `msg_` followed by 36 characters from `[0-9a-f-]`, as returned by a send. Any other shape answers `404 not_found` ("Route not found").

**Response:** `200`

```json
{ "id": "msg_…", "status": "failed", "error_code": "smtp_rejected" }
```

`status` and `error_code` are listed in [Delivery statuses](api-reference.md#delivery-statuses).

- **Unknown ids:** an unknown id, or one that belongs to another client, answers `404 not_found` ("Email not found").
- **Stuck sends:** a delivery that has been `processing` for more than 5 minutes is returned, and stored, as `failed` with `error_code: "abandoned"`.
- **Polling:** every call counts against the per-client rate limit.

```bash
curl "$NOTIFY_FLOW_URL/v1/email/msg_…" -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY"
```

## POST /v1/notifications

Sends the template mapped to an event. After resolving the event it behaves exactly like `POST /v1/email/send`: same headers, responses, `Idempotency-Key`s and per-recipient limit.

| Field | Required | Rule |
|---|---|---|
| `event` | yes | At most 64 characters, `^[a-z0-9_]+(\.[a-z0-9_]+)+$` (for example `auth.password_reset`) |
| `recipient.email` | yes | Same rule as `to` |
| `recipient.locale` | no | Same rule as `locale`. Default `en` |
| `data` | yes | Same rule as `variables`, for the resolved template |

**Resolution:** your mapping (see [events](api-reference-config.md#get-v1-events)), otherwise the built-in. Neither → `404 event_not_found`.

**Replays after a mapping change:** the event is resolved before the replay lookup, like the template checks described in [Idempotency](api-reference.md#idempotency). If the event was deleted or remapped to a template with different variables since the first request, a retry with the same key answers `404 event_not_found` or `400 invalid_variables` instead of the stored result. Nothing is ever sent twice.

**Errors:** those of `/v1/email/send`, plus `404 event_not_found`.

```bash
curl -X POST "$NOTIFY_FLOW_URL/v1/notifications" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: password-reset:user-123:req-456" \
  -d '{
    "event": "auth.password_reset",
    "recipient": { "email": "jane.doe@example.com", "locale": "en" },
    "data": { "appName": "Acme", "name": "Jane", "resetUrl": "https://app.acme.com/reset?token=..." }
  }'
```

### Built-in events


| Event | Template | `data` keys |
| --- | --- | --- |
| `user.welcome` | `welcome` | `appName`, `name` |
| `auth.email_verification` | `verify-email` | `appName`, `name`, `verifyUrl` |
| `auth.password_reset` | `password-reset` | `appName`, `name`, `resetUrl` |
| `auth.password_changed` | `password-changed` | `appName`, `name` |
| `auth.login_alert` | `login-alert` | `appName`, `name`, `device`, `ipAddress`, `time` |
| `notification.generic` | `generic-notification` | `appName`, `title`, `message` |

If you override a built-in template with your own version, its `data` keys become the variables your version declares.


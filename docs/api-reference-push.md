# Web Push

Part of the [API Reference](api-reference.md), which covers authentication, [idempotency](api-reference.md#idempotency) and the full [error table](api-reference.md#errors). To wire it into a web app, see the [Web Push guide](web-app-integration-push.md).

Web Push is opt-in: the operator configures the VAPID keys once, then switches push on for each client in the [admin dashboard](admin-dashboard.md#web-push). Until then, `/v1/push/*` answers `503` or `403`.

A notification carries no user-written text. It is a title and a short body rendered from a built-in template and a few short variables, plus an optional path and tag.

## Checks and limits

Every `/v1/push/*` route goes through the usual checks (per-IP limit, API key), then:

- **Per-client limit:** `/v1/push/*` has its own limit, 600 per 60 s per client, so the push and email budgets of a client are separate. The per-IP limit of 600 per 60 s is shared with email: if one backend spends its whole push budget from one IP, its emails can still hit it, so raise the IP limit when your traffic needs it.
- **`404 not_found` / `405 method_not_allowed`:** unknown routes and methods answer before the two checks below.
- **`503 push_not_configured`:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` or `VAPID_SUBJECT` is empty.
- **`403 push_disabled`:** push is not enabled for your client.

`DELETE /v1/push/subscriptions` skips the last two checks: erasing a user's devices always works, for example on account deletion.

## GET /v1/push/public-key

`200 {"public_key": "<VAPID_PUBLIC_KEY>"}`. Hand it to your frontend as `applicationServerKey`.

## PUT /v1/push/subscriptions

Registers one device of one user. Send the browser's `PushSubscription.toJSON()` (your backend forwards it, never the frontend).

```bash
curl -X PUT "$NOTIFY_FLOW_URL/v1/push/subscriptions" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "u_123",
    "subscription": {
      "endpoint": "https://fcm.googleapis.com/fcm/send/...",
      "keys": { "p256dh": "...", "auth": "..." }
    }
  }'
```

| Field | Rule |
|---|---|
| `user_id` | 1-128 characters, no control characters |
| `subscription.endpoint` | At most 2048 characters, `https:`, no port, no username or password. The host must be a supported push service, otherwise `400 unsupported_push_service` |
| `subscription.keys.p256dh` | Unpadded base64url that decodes to 65 bytes starting with `0x04` |
| `subscription.keys.auth` | Unpadded base64url that decodes to 16 bytes |

Supported push services: `fcm.googleapis.com` (Chrome, Opera, Samsung), `push.services.mozilla.com` (Firefox), `notify.windows.com` (Edge), `push.apple.com` (Safari). A host also matches when it ends with `.` plus one of these. `expirationTime` is ignored.

**Behavior:** an upsert on your client and the endpoint, so a repeated call is harmless and moving an endpoint to another user is allowed. Only a user's 10 newest devices are kept. Response `204`.

**Errors:** `400 validation_error` or `unsupported_push_service`; `403 push_disabled`; `503 push_not_configured`.

## DELETE /v1/push/subscriptions

The body has exactly one of two fields, otherwise `400 validation_error`:

- `{"endpoint": "…"}`: one device, for example on logout;
- `{"user_id": "…"}`: all of a user's devices, for example on account deletion.

Response `204`, even when nothing matched. It only touches your client's rows.

## POST /v1/push/send

Sends a notification to every device of one user.

**Headers:** `Authorization` or `X-API-Key`, `Content-Type: application/json`, `Idempotency-Key` (recommended).

```bash
curl -X POST "$NOTIFY_FLOW_URL/v1/push/send" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: msg:42:9871" \
  -d '{
    "user_id": "u_123",
    "template": "new-message",
    "locale": "it",
    "variables": { "appName": "Piattaforma XX", "sender": "Marco" },
    "url": "/chat/42",
    "tag": "chat-42"
  }'
```

| Field | Required | Rule |
|---|---|---|
| `user_id` | yes | As above |
| `template` | yes | `^[a-z0-9-]{1,64}$`, a [built-in push template](#built-in-push-template). Otherwise `404 template_not_found` |
| `locale` | no | `it`, `en` or `pt-BR`. Default `en`, and a missing locale falls back to `en` |
| `variables` | yes | An object whose keys are exactly the template's variables (otherwise `400 invalid_variables`). Each value is a string of 1-64 characters with no control characters |
| `url` | no | A path on your own site: 1-512 characters, starts with `/` but not `//`, no `\`, no control characters. The service worker opens it on its own origin, so a link to another site is impossible |
| `tag` | no | `^[A-Za-z0-9_-]{1,32}$`, for example the conversation id. Notifications with the same tag replace each other on screen, and while a phone is offline only the latest one survives |

The payload the device receives is `title` and `body`, plus `url` and `tag` when you sent them.

**Idempotency:** the same rules as email, in a separate namespace. A replay returns the stored `{id, status, devices}`, sends nothing, and is answered before the hourly limit.

**Hourly limit:** `PUSH_LIMIT_PER_HOUR` (default 60) per client, user and conversation: the `tag`, or the `template` when there is no tag. Failed sends do not count. Over the limit: `429 rate_limited`. Drop that push: earlier ones for the conversation are still on screen.

**Delivery:** each device gets its own request to its push service, in parallel. A transient failure (`429`, `5xx`, a network error or a 5 s timeout) is retried, up to 3 attempts 0.5 s and 1 s apart. A `404` or `410` means the device is gone, and its registration is deleted. Any other refusal fails that device but keeps its registration.

**Responses:**

| Status | Body |
|---|---|
| `200` | `{"id":"psh_…","status":"submitted","devices":2}`: a push service accepted the message for that many devices. It does not prove anyone saw it. A replayed `Idempotency-Key` returns the stored result instead, whose `status` may also be `failed` or `processing` |
| `404` | `no_subscriptions`: the user has no registered device. No record is written and there is no `id`. If every device turned out to be gone, the error carries `id` |
| `429` | `rate_limited` |
| `502` | `push_failed`, with `id`: no push service accepted the notification |

**Errors:** `400 validation_error`, `invalid_json` or `invalid_variables`; `403 push_disabled`; `404 template_not_found` or `no_subscriptions`; `413`; `429`; `502 push_failed`; `503 push_not_configured`. See [Errors](api-reference.md#errors).

The delivery record keeps `psh_…` ids, statuses (`processing`, `submitted`, `failed`) and error codes (`push_expired`, `push_failed`, `abandoned`), never the variables, text, `url` or endpoint.

## Built-in push template

Push templates are separate from email templates: `/v1/templates` does not list them, and `/v1/email/send` cannot use them.

| Template | Variables | Title | Body (`en`) |
|---|---|---|---|
| `new-message` | `appName`, `sender` | `{{appName}}` | `You received a notification from {{sender}}` |

The body is also available in `it` (`Hai ricevuto una notifica da {{sender}}`) and `pt-BR` (`Você recebeu uma notificação de {{sender}}`). The text is plain, with no HTML escaping.

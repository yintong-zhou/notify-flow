# Integrating notify-flow — event-based sending

Part of the [web app integration guide](web-app-integration.md).

## When to use it

With `POST /v1/email/send` the backend picks a template by name. With `POST /v1/notifications` it states what happened, for example `auth.password_reset`, and notify-flow picks the template. That choice lives in notify-flow: you can point an event to another template through the API, without redeploying the app.

Everything else is the same as `/v1/email/send`.

## Request

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

| Field | Required | Rules |
| --- | --- | --- |
| `event` | yes | At most 64 characters, `namespace.action` (lowercase letters, digits, `_`, at least one dot) |
| `recipient.email` | yes | A single address, as `to` in `/v1/email/send` |
| `recipient.locale` | no | `it`, `en` or `pt-BR`. Default: `en` |
| `data` | yes | An object of strings, with exactly the variables the resolved template declares |

## Response

The same as `/v1/email/send`:
- **Sync:** `200 {"id":"msg_…","status":"submitted"}`.
- **Async:** `202 queued` with `Prefer: respond-async` ([async guide](web-app-integration-async.md)).
- **Status:** read it with `GET /v1/email/:id`.
- **Shared with `/v1/email/send`:** `Idempotency-Key`s and the per-recipient limit. A key used on one endpoint replays its result on the other, and both count towards the same template's hourly limit.

## Built-in events

| Event | Template | `data` keys |
| --- | --- | --- |
| `user.welcome` | `welcome` | `appName`, `name` |
| `auth.email_verification` | `verify-email` | `appName`, `name`, `verifyUrl` |
| `auth.password_reset` | `password-reset` | `appName`, `name`, `resetUrl` |
| `auth.password_changed` | `password-changed` | `appName`, `name` |
| `auth.login_alert` | `login-alert` | `appName`, `name`, `device`, `ipAddress`, `time` |
| `notification.generic` | `generic-notification` | `appName`, `title`, `message` |

If you override a built-in template with your own version, its `data` keys become the variables your version declares.

## Managing mappings

Point an event to another template, or add a new event:

```bash
curl -X PUT "$NOTIFY_FLOW_URL/v1/events/auth.password_reset" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"template":"my-reset"}'
```

| Method and path | Purpose |
| --- | --- |
| `GET /v1/events` | Your mappings plus the built-ins you have not overridden (`builtin: true`) |
| `GET /v1/events/:event` | One mapping: `{event, template, builtin}` |
| `PUT /v1/events/:event` | Create or replace a mapping: `{template}` |
| `DELETE /v1/events/:event` | Delete your mapping. A built-in event goes back to its default; built-ins themselves can't be deleted |

- **Template check:** `PUT` requires the template to exist (yours in any locale, or a built-in), so a typo is caught right away.
- **Deleting a template** does not delete the mappings that point to it. Sends to those events then answer `404 template_not_found`.
- **Locales:** a mapping names a template, not a locale. The locale comes from `recipient.locale`, with the usual fallback to `en`.

## Errors

| HTTP status | `error.code` | What to do |
| --- | --- | --- |
| 400 | `validation_error` | Fix the payload: event name, `recipient`, `data` |
| 400 | `invalid_variables` | `data` does not match the template's variables |
| 404 | `event_not_found` | No mapping of yours and no built-in for this event |
| 404 | `template_not_found` | On `PUT`: the template doesn't exist. On send: the mapped template exists neither in that locale nor in `en` |

All other errors (`401`, `413`, `429`, `5xx`) are the same as for [`/v1/email/send`](web-app-integration.md#sending-an-email).

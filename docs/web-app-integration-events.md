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

Field rules: [`POST /v1/notifications`](api-reference-email.md#post-v1-notifications).

## Response

The same as `/v1/email/send`:
- **Sync:** `200 {"id":"msg_…","status":"submitted"}`.
- **Async:** `202 queued` with `Prefer: respond-async` ([async guide](web-app-integration-async.md)).
- **Status:** read it with `GET /v1/email/:id`.
- **Shared with `/v1/email/send`:** `Idempotency-Key`s and the per-recipient limit. A key used on one endpoint replays its result on the other, and both count towards the same template's hourly limit.
- **Replays after a mapping change:** the event is resolved before the replay lookup. If the event was deleted or remapped to a template with different variables since the first request, a retry with the same key answers `404 event_not_found` or `400 invalid_variables` instead of the stored result. Nothing is ever sent twice.

## Built-in events

Six events work out of the box (`user.welcome`, `auth.password_reset` and others), each mapped to a built-in template. The list, with each event's `data` keys, is in [Built-in events](api-reference-email.md#built-in-events).

## Managing mappings

Point an event to another template, or add a new event:

```bash
curl -X PUT "$NOTIFY_FLOW_URL/v1/events/auth.password_reset" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"template":"my-reset"}'
```

The routes (`GET /v1/events`, `GET`/`PUT`/`DELETE /v1/events/:event`) are described in [Events, templates and health](api-reference-config.md).

- **Template check:** `PUT` requires the template to exist (yours in any locale, or a built-in), so a typo is caught right away.
- **Deleting a template** does not delete the mappings that point to it. Sends to those events then answer `404 template_not_found`.
- **Locales:** a mapping names a template, not a locale. The locale comes from `recipient.locale`, with the usual fallback to `en`.

## Errors

Besides the errors of `/v1/email/send`, an event can answer `404 event_not_found` (no mapping of yours and no built-in). Every code is in [Errors](api-reference.md#errors).

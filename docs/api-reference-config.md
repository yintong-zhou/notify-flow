# Events, templates and health

Part of the [API Reference](api-reference.md). Every route here needs the API key and answers errors as described in [Errors](api-reference.md#errors). Event and template changes apply to your client only.

## GET /v1/events

Lists your event mappings, then the built-in events you have not overridden.

**Response:** `200`, your own mappings sorted by `event`, then the built-ins:

```json
[
  { "event": "auth.password_reset", "template": "my-reset", "updated_at": 1760000000, "builtin": false },
  { "event": "user.welcome", "template": "welcome", "builtin": true, "updated_at": null }
]
```

```bash
curl "$NOTIFY_FLOW_URL/v1/events" -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY"
```

## GET /v1/events/:event

Reads one mapping: yours, otherwise the built-in.

**Response:** `200 {"event":"auth.password_reset","template":"password-reset","builtin":true}`

**Errors:** `400 validation_error` if `event` breaks the [event rule](api-reference-email.md#post-v1-notifications); `404 event_not_found`.

## PUT /v1/events/:event

Creates or replaces a mapping. Use it to point a built-in event to your own template, or to add a new event.

| Field | Required | Rule |
|---|---|---|
| `template` | yes | `^[a-z0-9-]{1,64}$`, and the template must exist: yours in any locale, or a built-in |

**Response:** `200 {"event":"auth.password_reset","template":"my-reset","builtin":false}`

**Errors:** `400 validation_error`; `404 template_not_found` when the template doesn't exist, so a typo surfaces now rather than on the first send.

```bash
curl -X PUT "$NOTIFY_FLOW_URL/v1/events/auth.password_reset" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"template":"my-reset"}'
```

## DELETE /v1/events/:event

Deletes your mapping. Deleting an override brings back the built-in; built-ins themselves can't be deleted.

**Response:** `204`, no body. **Errors:** `404 event_not_found` when you have no mapping for the event.

Deleting a template does not delete the mappings that point to it: sends to those events then answer `404 template_not_found`.

## GET /v1/templates

Lists your templates, then the built-in ones you have not overridden.

**Response:** `200`, your own templates sorted by name and locale, then the built-ins:

```json
[
  { "name": "order-shipped", "locale": "en", "updated_at": 1760000000, "builtin": false },
  { "name": "welcome", "locale": "it", "builtin": true, "updated_at": null }
]
```

## GET /v1/templates/:name/:locale

Reads one template: yours, otherwise the built-in. There is no fallback to `en` here.

**Response:** `200 {"name","locale","subject","html","text","variables","builtin"}`

**Errors:** `400 validation_error` if `name` breaks `^[a-z0-9-]{1,64}$` or `locale` is not `it`, `en` or `pt-BR`; `404 template_not_found`.

## PUT /v1/templates/:name/:locale

Creates or replaces your template. A name that matches a built-in overrides it for your client only.

| Field | Required | Rule |
|---|---|---|
| `subject` | yes | 1 to 255 characters, on a single line |
| `html` | yes | A string of at most 100 KB |
| `text` | yes | A string of at most 50 KB |
| `variables` | yes | An array of names matching `^[a-zA-Z0-9_]{1,64}$`. Duplicates are removed |

- **Placeholders:** written `{{name}}` in `subject`, `html` and `text`. Each one must be listed in `variables`, otherwise `400 validation_error` ("undeclared placeholders: …").
- **Escaping:** values are HTML-escaped in `html`, and line breaks are stripped from `subject`.
- **Response:** `200` with the stored template and `"builtin": false`.

```bash
curl -X PUT "$NOTIFY_FLOW_URL/v1/templates/order-shipped/en" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "Your order {{orderId}} is on its way",
    "html": "<p>Hi {{name}},</p><p>we shipped order {{orderId}}.</p>",
    "text": "Hi {{name}},\nwe shipped order {{orderId}}.",
    "variables": ["name", "orderId"]
  }'
```

## DELETE /v1/templates/:name/:locale

Deletes your template. Built-ins can't be deleted; deleting your override brings the built-in back.

**Response:** `204`, no body. **Errors:** `404 template_not_found` when you have no template with that name and locale.

## GET /health

Checks that the Worker is up. It needs no API key and is not rate limited.

**Response:** `200 {"status":"ok"}`

```bash
curl "$NOTIFY_FLOW_URL/health"
```

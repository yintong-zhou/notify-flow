# Event-based `POST /v1/notifications` — Design

Date: 2026-10-11
Builds on: [MVP design](2026-10-08-notification-service-mvp-design.md) and [async sending](2026-10-11-async-queue-design.md)
Source requirements: [`notification-service.md`](../../../notification-service.md) ("A more abstract API can be introduced later")

## Goal

**Decoupling:** a backend states what happened (`auth.password_reset`) instead of choosing a template. The service resolves the event to a template, and each client can change that mapping through the API without touching the calling app.

Success:
- `POST /v1/notifications` with a built-in or client-mapped event sends the same email `POST /v1/email/send` would send for the resolved template.
- It works with every existing guarantee: sync or async via `Prefer`, `Idempotency-Key`, the recipient limit, the same statuses, and `GET /v1/email/:id`.

## Decisions

- **Thin adapter:** the endpoint resolves `event → template name`, builds a normal `SendRequest`, and reuses the existing send and enqueue pipeline. No new delivery logic.
- **Mapping storage:** built-in mappings in code, plus per-client overrides in D1 managed via `/v1/events`, mirroring how templates work.
- **One event, one email.** No fan-out and no other channels.
- **Rejected:**
  - a mapping column on `templates`: templates exist per locale, and an unoverridden built-in would have nowhere to store it;
  - generic routing rules with channels and conditions: YAGNI. They can be layered on later without changing this API.

## `POST /v1/notifications`

```http
POST /v1/notifications
Authorization: Bearer <key>
Idempotency-Key: …            (optional, as today)
Prefer: respond-async         (optional, as today)

{
  "event": "auth.password_reset",
  "recipient": { "email": "jane@example.com", "locale": "it" },
  "data": { "appName": "Acme", "name": "Jane", "resetUrl": "https://…" }
}
```

**Validation** (`400 validation_error` unless noted):
- **`event`:** a string of at most 64 characters matching `^[a-z0-9_]+(\.[a-z0-9_]+)+$` (at least one dot).
- **`recipient`:** an object.
  - `recipient.email` follows the same rules as `to` today: single address, printable ASCII, at most 254 characters, lowercased.
  - `recipient.locale` is optional (`it`, `en`, `pt-BR`), default `en`.
- **`data`:** an object of strings. Its keys must match the resolved template's variables exactly, otherwise `400 invalid_variables` (existing check).

**Resolution:**
1. **Event → template name:** the client's row in `event_routes`, otherwise the built-in map, otherwise `404 event_not_found`.
2. **Template name → template:** the existing `resolveTemplate` (client template, then built-in, then the `en` fallback), otherwise `404 template_not_found`.

**Response and behavior:** identical to `POST /v1/email/send` for `{template, to: recipient.email, locale, variables: data}`:
- `200 {id, status}` sync, or `202 {id, "queued"}` with `Prefer: respond-async` and `Preference-Applied`;
- the same errors (`413`, `429`, `502`, `503` and so on);
- the same `email_deliveries` row, with `template` set to the **resolved** template name. The per-recipient limit is therefore shared with `/v1/email/send` for the same template, so it cannot be bypassed by switching endpoints;
- no `event` column (YAGNI).

**Built-in events:**

| Event | Template |
|---|---|
| `user.welcome` | `welcome` |
| `auth.email_verification` | `verify-email` |
| `auth.password_reset` | `password-reset` |
| `auth.password_changed` | `password-changed` |
| `auth.login_alert` | `login-alert` |
| `notification.generic` | `generic-notification` |

## Data: migration `0005_event_routes.sql`

```sql
CREATE TABLE event_routes (
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  template   TEXT NOT NULL,      -- template name; the locale is chosen at send time
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, event)
);
```

## `/v1/events` API

Mirrors `/v1/templates`, so the response shapes follow `src/routes/templates.ts`.

| Method and path | Behavior |
|---|---|
| `GET /v1/events` | `200 [{event, template, builtin, updated_at}]`: the client's rows (`builtin: false`), then the built-ins it has not overridden (`builtin: true`, `updated_at: null`) |
| `GET /v1/events/:event` | `200 {event, template, builtin}`, or `404 event_not_found` |
| `PUT /v1/events/:event` | Body `{template}`. Upserts and answers `200 {event, template, builtin: false}` |
| `DELETE /v1/events/:event` | Deletes the client's row: `204`. No client row, built-ins included: `404 event_not_found`. Afterwards the built-in applies again, if any |

**`PUT` validation:**
- `:event` must match the event regex.
- `template` must match `^[a-z0-9-]{1,64}$`.
- `template` must exist for this client in some locale or as a built-in, otherwise `404 template_not_found`, so a typo surfaces at configuration time.
- The body follows the existing `readJson` rules: 256 KB limit, JSON object.

**Deleted templates:** deleting a template that an event points to is not blocked. Sends then answer `404 template_not_found`, as a wrong template name does today.

## Code

- **`src/routes/email.ts`:** extract the `Prefer` / `202` / `waitUntil` handling out of `sendEmail` into an exported `dispatch(req, env, clientId, request, send, ctx)`. `sendEmail` and the new route both call it, so the sync and async behavior lives in one place.
- **`src/templates/events.ts`:**
  - `BUILTIN_EVENTS`;
  - `resolveEvent(db, clientId, event): Promise<string>`, which throws `404 event_not_found`;
  - `templateExists(db, clientId, name): Promise<boolean>`.
- **`src/security/validation.ts`:**
  - `EVENT_RE`;
  - `parseNotification(body): { event: string; to: string; locale: Locale; variables: Record<string, string> }`, which reuses the `to`, locale and variables checks of `parseSendRequest`;
  - `parseEvent(raw): string`;
  - `parseEventRoute(body): { template: string }`.
- **`src/routes/notifications.ts`:** parse, resolve, build the `SendRequest`, and call `dispatch`.
- **`src/routes/events.ts`:** the CRUD.
- **`src/index.ts`:** `POST /v1/notifications` and `/v1/events[/:event]`. The IP and per-client rate limits apply, as on every `/v1/*` route.

## Testing

New file `test/notifications.test.ts`, with dependency injection as today (`call`, `recorder`, `fakeQueue`).

- **Sending:**
  - a built-in event renders and sends the mapped template;
  - a client mapping sends a differently named client template;
  - `404 event_not_found`; `400` for an invalid event name, a missing `recipient` and a bad email; `400 invalid_variables` when `data` does not match;
  - `recipient.locale` selects the locale;
  - `Prefer: respond-async` answers `202` and enqueues the resolved template;
  - an `Idempotency-Key` replay sends nothing;
  - the shared recipient limit: 3 sends via `/v1/email/send` and 2 via the event pass, and the 6th is `429`.
- **Events CRUD:**
  - the list includes built-ins, and an override replaces its built-in entry;
  - `PUT` to a missing template answers `404`, and `PUT` with an invalid event or template name answers `400`;
  - mappings are isolated per client;
  - `DELETE` on a built-in answers `404`, and `DELETE` on an override answers `204` and restores the built-in.
- **Regression:** the existing `/v1/email/send` tests pass unchanged after the `dispatch` extraction.

## Documentation

- **Integration guide:** a new linked part, `docs/web-app-integration-events.md`, covering the request, built-in events, managing mappings and errors. The main guide gets one link.
- **README:** a short "Send an event" section in the API part (the README is at 194 lines and stays under 200).
- **CLAUDE.md:** remove the endpoint from "Not in the MVP", and add a line about events to "Architecture".
- **Deploy:** migration `0005` before `npm run deploy`.

# Web Push notifications — Design, part 2

Continues [part 1](2026-10-25-web-push-design.md) (intent, decisions, constraints, data). *My call* marks a choice the user did not make explicitly.

## API (`/v1/push/*`)

Every route goes through the usual pipeline: per-IP limit, API key, per-client limit.

**Per-client limit (*my call*):** `/v1/push/*` uses its own `PUSH_RATE_LIMITER` binding (default 600 per 60 s per client) instead of `CLIENT_RATE_LIMITER`. Chat traffic can then never cause a 429 on password-reset emails. `IP_RATE_LIMITER` rises from 300 to 600 per 60 s (decided with the user, for now). A backend that uses its whole push budget from one IP can still reach the IP limit, so raise it when real traffic gets there. Both numbers are config.

After the limits:
- `503 push_not_configured` if `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` or `VAPID_SUBJECT` is empty;
- `403 push_disabled` if the client's `push_enabled` is 0.

`DELETE /v1/push/subscriptions` is exempt from both checks (*my call*): erasing a user's devices must always work, for example on account deletion.

### `GET /v1/push/public-key`

`200 {"public_key": "<VAPID_PUBLIC_KEY>"}`. The backend hands it to its frontend as `applicationServerKey`.

### `PUT /v1/push/subscriptions`

```json
{ "user_id": "u_123",
  "subscription": { "endpoint": "https://fcm.googleapis.com/fcm/send/…", "keys": { "p256dh": "…", "auth": "…" } } }
```

`subscription` is the browser's `PushSubscription.toJSON()`. `expirationTime` is ignored.

Validation, `400 validation_error` unless noted:
- **`user_id`:** 1-128 characters, no control characters.
- **`endpoint`:** at most 2048 characters, `https:`, no explicit port and no userinfo. The hostname must equal an allowlisted host or end with `.` plus that host, otherwise `400 unsupported_push_service`. This is the SSRF guard (*my call*). Allowlist: `fcm.googleapis.com` (Chrome, Opera, Samsung), `push.services.mozilla.com` (Firefox), `notify.windows.com` (Edge), `push.apple.com` (Safari).
- **`keys.p256dh`:** base64url that decodes to 65 bytes starting with `0x04`.
- **`keys.auth`:** base64url that decodes to 16 bytes.

Behavior: upsert on `(client_id, endpoint)`, setting `user_id`, the keys and `created_at = now`. Then only that user's 10 newest subscriptions are kept, the rest are deleted (*my call*). Response `204`.

### `DELETE /v1/push/subscriptions`

The body has exactly one of two fields:
- `{"endpoint": "…"}`: one device, for example on logout;
- `{"user_id": "…"}`: all of a user's devices, for example on account deletion.

Response `204`, even when nothing matched.

### `POST /v1/push/send`

```http
POST /v1/push/send
Idempotency-Key: …   (optional)

{ "user_id": "u_123", "template": "new-message", "locale": "it",
  "variables": { "appName": "Piattaforma XX", "sender": "Marco" },
  "url": "/chat/42", "tag": "chat-42" }
```

Validation (`400 validation_error` unless noted):
- **`user_id`:** as above.
- **`template`:** matches `^[a-z0-9-]{1,64}$` and names a built-in push template, otherwise `404 template_not_found`.
- **`locale`:** `it`, `en` or `pt-BR`, default `en`. Falls back to `en` as for email.
- **`variables`:** an object of strings. Each value is 1-64 characters with no control characters (*my call*: it keeps message text out mechanically). The keys must match the template's variables exactly, otherwise `400 invalid_variables` (existing `checkVariables`).
- **`url`** (optional): a path on the platform's own site, 1-512 characters. It starts with `/`, does not start with `//`, and contains no `\` and no control characters. The service worker resolves it against its own origin, so a stolen key cannot push a link to another site (*my call*).
- **`tag`** (optional): matches `^[A-Za-z0-9_-]{1,32}$`, for example the conversation id. The browser uses it as the notification tag, so notifications for one conversation replace each other instead of stacking. The push service uses it as the `Topic` header, so only the latest undelivered one survives while a phone is offline (*my call*).

Flow:
1. Parse `Idempotency-Key` before the body, as `/v1/email/send` does. Validate, resolve the template and check the variables.
2. **Replay:** a known `Idempotency-Key` returns the stored `{id, status, devices}` and sends nothing.
3. **Load the user's subscriptions.** If there are none, answer `404 no_subscriptions` and write no row.
4. **Reserve:** insert the `processing` row with the hourly limit counted in the same `INSERT`, like `reserveDelivery`, failed rows excluded. A concurrent duplicate `Idempotency-Key` is handled as for email.
   - The limit is `PUSH_LIMIT_PER_HOUR` (default 60, *my call*) per client, user and conversation: `tag`, or `template` when there is no tag. A busy group chat therefore cannot silence a one-to-one chat.
   - Over the limit, answer `429 rate_limited`. The backend just drops that push: the earlier notifications for that conversation are still on screen.
5. **Render** title and body as plain text (no HTML escaping). The payload is `{"title","body","url"?,"tag"?}` and nothing else.
6. **Send to every device in parallel.** For each device, encrypt the payload with its keys (RFC 8291 `aes128gcm`) and `POST` to its endpoint with:
   - `TTL: 86400` (*my call*)
   - `Urgency: high`
   - `Topic: <tag>`, when a tag is given
   - `Content-Encoding: aes128gcm`
   - `Authorization: vapid t=<JWT>, k=<VAPID_PUBLIC_KEY>`

   The JWT is ES256 (RFC 8292) with claims `aud` = the endpoint's origin, `exp` = now + 12 h and `sub` = `VAPID_SUBJECT`.
7. **Handle each device's response:**
   - 2xx: accepted.
   - 404 or 410: the subscription is gone, so delete its row.
   - 429, 5xx, a network error or a 5 s timeout: transient. Up to 3 attempts, with 500 ms then 1000 ms backoff, as for SMTP.
   - Any other 4xx: permanent for this device, but the row is kept.
   - Every failed attempt logs warn `push_attempt_failed` with `client_id`, `message_id` and detail `HTTP <status> attempt n/3` (or `network …`). The endpoint is never logged.
8. **Close the row:**
   - At least one device accepted: `submitted`, with `devices = n` and `sent_at`. Answer `200 {"id","status":"submitted","devices":n}`. As for email, this `UPDATE` sits outside the error path: a D1 error after the push went out must not mark the row failed.
   - No device accepted, and every subscription was gone: `failed`/`push_expired`, answer `404 no_subscriptions` with `{id}`.
   - No device accepted, any other mix: `failed`/`push_failed`, answer `502 push_failed` with `{id}`.

`submitted` means a push service accepted the message, not that anyone saw it, as for email.

## Built-in push template

`new-message`, with variables `appName` and `sender` (decided with the user):

| Locale | Title | Body |
|---|---|---|
| `it` | `{{appName}}` | `Hai ricevuto una notifica da {{sender}}` |
| `en` | `{{appName}}` | `You received a notification from {{sender}}` |
| `pt-BR` | `{{appName}}` | `Você recebeu uma notificação de {{sender}}` |

Push templates are separate from email templates: `/v1/templates` does not list them, and `/v1/email/send` cannot use them.

## Admin: per-client switch (*my call*: in the dashboard)

- **`GET /admin/api/clients`** returns `{"push_configured": bool, "clients": [{"id","name","created_at","push_enabled","push_devices"}]}`, where `push_devices` is the client's subscription count.
- **`POST /admin/api/client-push`** takes `{"client_id","enabled"}` and answers `204`. It answers `404` for an unknown client, and `409 push_not_configured` when enabling while the VAPID settings are missing. Same session and `requireJson` rules as the other admin routes.
- **UI:** a new "Clients" section in `public/admin/` lists name, id, created date, devices and a Push switch. If push is not configured, the switch is disabled and a hint links to the setup docs.
- **Disabling** keeps the subscriptions. Registration and sending answer `403` until push is enabled again.

## Configuration

- **Rate limit bindings:** a new `PUSH_RATE_LIMITER` (600 per 60 s), and `IP_RATE_LIMITER` raised to 600, in both wrangler files.
- **`vars`** in `wrangler.jsonc.example` and the local `wrangler.jsonc`:
  - `VAPID_PUBLIC_KEY`: base64url uncompressed P-256 point, 65 bytes. An empty value means push is not configured.
  - `VAPID_SUBJECT`: a `mailto:` address or `https:` URL that push services can contact.
  - `PUSH_LIMIT_PER_HOUR`: default `"60"`.
- **Secret `VAPID_PRIVATE_KEY`:** base64url, 32 bytes. Add it to `.dev.vars.example`. Do not add it to `secrets.required`: a deployment without push must still deploy.
- **`npm run push:keys`** runs `scripts/vapid-keys.mjs`. It generates the pair with `node:crypto` (no dependency) and prints the public key, the private key and the `wrangler secret put` command.
- **Rotation:** do not rotate the keys unless they were compromised. Every browser then has to subscribe again (see "Frontend reference").

## Frontend reference (`docs/web-app-integration-push.md`)

Copyable code for the platform. Nothing here runs in notify-flow.
1. **Requirements:** HTTPS and a service worker on the platform's origin. On iPhone, also a web app manifest and the app added to the Home Screen.
2. **Subscribe** after a user's click, never on page load:
   - `Notification.requestPermission()`;
   - then `pushManager.subscribe({userVisibleOnly: true, applicationServerKey})`;
   - then send `subscription.toJSON()` to the platform's own backend, which calls `PUT /v1/push/subscriptions`.
3. **On every app start** with permission granted, check `getSubscription()`. If it is null, or its `options.applicationServerKey` differs from the current public key, unsubscribe, subscribe and register again. This covers Safari revocations and key rotation, and a repeated registration is harmless.
4. **On logout:** the backend calls `DELETE {endpoint}`, then the page calls `subscription.unsubscribe()`.
5. **Service worker:**
   - on `push`: `event.waitUntil(showNotification(title, {body, tag, renotify: !!tag, icon, data: {url}}))`, **always**;
   - on `notificationclick`: focus an open window on that URL, otherwise `clients.openWindow(url ?? "/")`.
6. **Chat open rule, in the backend** (decided with the user): when a message arrives and the recipient has that conversation open and focused on any device, deliver it only through the platform's realtime channel. Otherwise call `POST /v1/push/send` with `tag` = conversation id and `url` = conversation path. The platform defines "open", for example a focused window reported over its realtime connection.
7. **Page cleanup:** when a conversation is opened, or shows a new message while focused, the page closes that tag's notifications via `registration.getNotifications({tag})`.

**This changes what I told the user (*my call*).** I had said the service worker would skip the notification when the chat is already on screen. Safari revokes subscriptions that do that, so the service worker always shows the notification. The backend rule (point 6) keeps the chat-open case from sending at all. The page cleanup (point 7) closes the rare notification that slips through just as the chat opens.

## Documentation to update (every Markdown file under 200 lines)

- **New pages:**
  - `docs/api-reference-push.md` (the contract above), linked from `docs/api-reference.md` and the VitePress sidebar;
  - `docs/web-app-integration-push.md`, linked from `docs/web-app-integration.md` and the sidebar.
- **API contract copies:** `docs/ai-integration-prompt.md` and `docs/ai-management-page-prompt.md` get the push endpoints, marked opt-in.
- **`docs/admin-dashboard.md`:** the Clients section.
- **README:** drop Web Push from the roadmap and add setup (keys, vars, migration). The README is at 196 lines, so tighten it to stay under 200.
- **CLAUDE.md:** the push flow in Architecture, the new vars and secret, and the rate-limit line (`PUSH_RATE_LIMITER`, IP limit 600, the per-conversation hourly limit). Also the no-content rule for `push_deliveries` and the roadmap line.
- **Config files:** `wrangler.jsonc.example`, the local `wrangler.jsonc`, `.dev.vars.example`, and the `package.json` script.

## Tests

`vi.mock` does not work in the Workers pool, so inject the push HTTP function the way `send` is injected for SMTP.
- **Encryption:** reproduces RFC 8291 Appendix A byte for byte, with the ephemeral key and salt injected.
- **Round trip:** a key pair generated in the test decrypts what is sent.
- **VAPID JWT:** checks `aud`, `exp` and `sub`, and the signature verifies with the public key.
- **Gates:** `503` when not configured, `403` when disabled, and `DELETE` working in both cases.
- **Subscriptions:**
  - the allowlist rejects a lookalike such as `fcm.googleapis.com.evil.com`, `http:` and an explicit port;
  - key lengths are checked;
  - an upsert moves the endpoint to a new user;
  - the cap keeps the 10 newest;
  - delete works by endpoint and by user.
- **Send:**
  - `no_subscriptions` writes no row;
  - `invalid_variables`, a 65-character value, and `url` set to `//x` or `https://x` are rejected;
  - a replay sends nothing;
  - `429` at the limit, with failed rows excluded, and a different `tag` still sending;
  - push traffic over its own limiter does not cause a 429 on `/v1/email/send`;
  - a 410 removes the subscription;
  - a 503 is retried and then accepted;
  - mixed results give `submitted` with the device count;
  - all gone gives `404` and `push_expired`;
  - all rejected gives `502`.
- **No content:** scan `app_logs` and `push_deliveries` for variable values, the URL and the endpoint.
- **Admin:** list, toggle, `409` when not configured, session required. The existing tests stay green.

## Left to the builder

- **Module layout.** Suggested: `src/push/` for VAPID, encryption, the sender and the built-in templates, plus `src/routes/push.ts`.
- **HTTP injection:** how the push HTTP function reaches `handle()` and the tests.
- **Rendering:** whether to reuse the placeholder code in `renderer.ts`.
- **SQL details:** the per-user cap, the purge, and the 5 s timeout mechanism.
- **Admin markup:** within the existing dashboard style.

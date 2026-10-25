# Web Push notifications — Design

Date: 2026-10-25
Builds on: [MVP design](2026-10-08-notification-service-mvp-design.md), [event notifications](2026-10-11-notifications-design.md), [admin dashboard](2026-10-15-admin-dashboard-design.md)
Source requirements: [`notification-service.md`](../../../notification-service.md) ("the service may also be extended to Web Push notifications")
Continues in: [part 2](2026-10-25-web-push-design-part2.md) (API, sending, admin, config, frontend reference, tests)

## Intent

The platforms that use notify-flow have their own in-app messaging. When a user receives a message and is not looking at that chat, their browser must show a system notification within seconds, whether the web app is open or closed:

> **Piattaforma XX** — Hai ricevuto una notifica da Marco

This is a separate channel from email, not a variant of it. The conversation and its messages live in the platform's own database. notify-flow only makes the alert appear: it never sees, stores or relays what users write to each other.

**Success:**
- A platform backend calls one endpoint with its user id. Every browser that user enabled shows the notification within seconds.
- Nobody gets the notification while they are reading that chat.
- A client that never turned push on sees no change at all.
- Every existing guarantee still holds: templates only, API key, rate limits, idempotency, no content in logs, no runtime dependencies.

## Decided with the user

1. **Use case:** notifications for real-time messaging inside a platform, delivered whether the web app is open or closed.
2. **Opt-in:** off by default for every client, and switched on per client.
3. **Messages stay in the platform.** Chat messages live in the platform's database, never in notify-flow. notify-flow keeps in D1 only what it needs to send: subscriptions, the per-client switch, and a delivery log without content.
4. **No user-written text in a notification, not even as a preview, in this phase.** The notification only says who wrote, for example "Hai ricevuto una notifica da Marco".
5. **A built-in base template is the default**: title `{{appName}}`, body "Hai ricevuto una notifica da {{sender}}".
6. **Chat open means no notification, only the message in the chat.** The platform backend does not call notify-flow when it delivered the message to an open chat. If the chat is open on the PC, the phone does not buzz either.
7. **Only backends call notify-flow** (played back, not contested). The browser hands its subscription to its own backend, and that backend registers it.

## Goals

- Store browser push subscriptions per client and user, with several devices per user.
- Send a templated notification to all of a user's devices, following the Web Push standards (RFC 8030 protocol, RFC 8291 payload encryption, RFC 8292 VAPID), implemented with WebCrypto.
- A per-client on/off switch in the admin dashboard, off by default.
- Documentation with a ready-to-copy browser side: subscription flow, service worker, and the "chat open" rule for the backend.

## Non-goals (this phase)

- **Any user-written text in the payload**, including previews. This is the user's decision (point 4).
- **Custom push templates via the API.** *My call:* only built-in push templates in this phase. A `/v1/push/templates` API mirroring `/v1/templates` can come later, when a platform needs other wording.
- **Async sending through the queue.** *My call:* a push service answers in milliseconds, so sending is sync only. `Prefer: respond-async` is ignored on push routes.
- **Push through `POST /v1/notifications` events.** The two channels stay separate.
- **Multi-recipient send.** *My call:* one call per recipient, so a group-chat message to N people is N calls, all within the push limiter. Add a `user_ids` array if a platform's groups make that too slow.
- **Per-client VAPID keys.** The roadmap item "encrypted per-tenant credentials in a database" covers this. One service-wide key pair for now.
- **Push statistics and search in the admin dashboard.** The Database section can already query `push_deliveries`.
- **Presence tracking in notify-flow.** Whether the chat is open is the platform's knowledge (point 6).
- **Native mobile push** (APNs/FCM for native apps) and **Safari's Declarative Web Push**.
- **Icons, images or action buttons in the payload.** The platform's service worker adds its own icon.

## Anti-goals (a failure even if it works)

- A message someone wrote reaches notify-flow, its database, its logs, or a notification.
- notify-flow stores, relays or mirrors chat messages.
- Push is on for a client that never enabled it.
- A recipient reading the chat also gets a system notification for it, as a normal outcome.
- A browser calls notify-flow directly, or the API key reaches frontend code.
- A new runtime dependency.
- Variables, click URLs, endpoints or browser keys in `app_logs`.
- A stolen API key can make notify-flow `POST` to arbitrary URLs (SSRF) or push links to other sites.

## Constraints

- **Carried over from CLAUDE.md:** templates only, API key auth (hex SHA-256), the per-IP and per-client rate limits on every `/v1/*` route, `Idempotency-Key`, logs only through `log()`, statuses never `delivered`, no runtime dependencies.
- **Workers runtime:** outbound `fetch` to the push service. ECDH P-256, HKDF, AES-128-GCM and ECDSA P-256 all come from WebCrypto.
- **Safari requires a visible notification for every push.** After about three pushes that show nothing, it revokes the subscription ([WebKit commit](https://webkit.googlesource.com/WebKit/+/108ccb442e40e9705d212e74c1f213e3b5a0ea05), [Meet Web Push](https://webkit.org/?p=12945)). So the "chat open" rule must live in the platform backend, not in the service worker (see part 2, "Frontend reference").
- **iPhone and iPad:** Web Push only works for a web app added to the Home Screen (iOS/iPadOS 16.4+). The platform needs a web app manifest. A plain Safari tab cannot subscribe.
- **One VAPID key for all clients.** The push service rejects a key change for existing subscriptions, so rotating the key means every browser must subscribe again. A subscription (endpoint and browser keys) is only as private as the platform keeps it.

## How it works

```text
Browser (platform)        Platform backend                 notify-flow                 Push service
1. permission + subscribe
   (VAPID public key) ──► 2. PUT /v1/push/subscriptions ──► store (client, user, device)
                          3. new chat message:
                             recipient's chat open? ─ yes ─► (nothing: the chat shows it)
                             no ──► POST /v1/push/send ───► render template, encrypt,
                                                            sign VAPID, POST per device ──► browser
4. service worker shows "Piattaforma XX — Hai ricevuto una notifica da Marco"; a click opens the chat
```

## Data: migration `0008_push.sql`

```sql
-- Off by default: a client opts in from the admin dashboard.
ALTER TABLE clients ADD COLUMN push_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE push_subscriptions (
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL,     -- push service URL; host on the allowlist
  user_id    TEXT NOT NULL,     -- the caller's own user id, opaque to notify-flow
  p256dh     TEXT NOT NULL,     -- browser public key, base64url (65 bytes decoded)
  auth       TEXT NOT NULL,     -- browser auth secret, base64url (16 bytes decoded)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, endpoint)
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (client_id, user_id, created_at);

CREATE TABLE push_deliveries (
  id              TEXT PRIMARY KEY,  -- psh_<uuid>
  request_id      TEXT NOT NULL,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  idempotency_key TEXT,
  template        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  tag             TEXT,              -- the caller's conversation id, if given: keys the hourly limit
  status          TEXT NOT NULL CHECK (status IN ('processing','submitted','failed')),
  devices         INTEGER NOT NULL DEFAULT 0,  -- subscriptions the push service accepted
  error_code      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE (client_id, idempotency_key)
);
CREATE INDEX idx_push_deliveries_rate ON push_deliveries (client_id, user_id, created_at);
```

- **Separate tables:** `email_deliveries` stays untouched, so email stats, search and purge keep working unchanged.
- **Primary key `(client_id, endpoint)`:** the same browser registered again under the same client updates the row, with a new user after logout and login, or new keys. Another client registering that endpoint gets its own row and cannot take over the first client's row.
- **`push_deliveries` stores no content:** no variables, no title or body, no click URL, no endpoint. Variables and the URL exist only in memory and in the encrypted payload. `tag` is an id the caller picks, such as the conversation id, and holds nothing users wrote.
- **Retention:** the daily cron deletes `push_deliveries` rows older than 30 days, like email, and closes `processing` rows abandoned for more than 300 s as `failed`/`abandoned`. Subscriptions have no expiry by age. They are removed when the push service answers 404/410, on `DELETE`, or by the per-user cap.

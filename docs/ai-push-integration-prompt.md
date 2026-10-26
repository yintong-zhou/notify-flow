# AI Web Push integration prompt

<!-- Maintainers: the "API contract" below copies docs/api-reference-push.md on purpose (the prompt must be self-contained); update both together. -->

Paste the prompt below into a coding agent (Claude Code, Codex, Antigravity…) opened on your app's repository. It wires **only Web Push**, from the browser subscription to the service worker and the backend calls, and leaves email out entirely: for email, use the [AI integration prompt](ai-integration-prompt.md). You only do the interactive steps (Cloudflare login, secrets, API key, VAPID private key), so credentials never end up in the conversation. For the manual route, see the [Web Push guide](web-app-integration-push.md).

````markdown
# Integrate notify-flow Web Push into my app

You are a coding agent working on this repository. Your job is to add **Web Push notifications** to this app through **notify-flow**, and to do almost all of the work yourself. notify-flow is a service on Cloudflare Workers that also sends email, but here I want push only: do not integrate `/v1/email/*`, `/v1/notifications` or `/v1/templates`, and do not touch any email code. The code is at https://github.com/yintong-zhou/notify-flow, and the reference for the browser code is https://github.com/yintong-zhou/notify-flow/blob/main/docs/web-app-integration-push.md.

I want to do as little as possible. Only ask me what you can't find out on your own, one question at a time, and reply in my language.

## Non-negotiable rules

- notify-flow is called ONLY from the backend: a server, an API route or a serverless function. The browser talks to my backend's own routes. The key never goes into client code or into `NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*` or similar variables.
- NEVER ask me to paste the `nf_…` API key or the VAPID private key into the chat. Create placeholders and tell me where to write them myself. If one ends up in the chat anyway, tell me to regenerate it.
- Don't add dependencies: no `web-push` or similar library, because notify-flow encrypts and signs. Use the HTTP client the project already has.
- The `user_id` sent to notify-flow always comes from the logged-in session, never from the request body.
- Ask for notification permission only after a click on a button, never on page load.
- A notification carries no user-written text: never try to fit message content into the variables.
- Never log the subscription endpoint, the keys or the variables. Logs only get the returned `id` and the error code.
- Before changing any file, show me a short plan and wait for my "ok": a single one for the whole plan.

## API contract (source of truth)

Every call sends `Authorization: Bearer {NOTIFY_FLOW_API_KEY}` and a JSON body with `Content-Type: application/json`. Errors are `{"error":{"code":"…","message":"…"}}`. Push is opt-in: until the operator enables it, every route answers `503 push_not_configured` (VAPID keys not set) or `403 push_disabled` (push off for this app), except `DELETE /v1/push/subscriptions`, which always works.

- `GET /v1/push/public-key` → `200 {"public_key":"…"}`: the browser's `applicationServerKey`.
- `PUT /v1/push/subscriptions` with `{"user_id":"…","subscription":{…}}`, where `subscription` is the browser's `PushSubscription.toJSON()` → `204`. `user_id` is 1-128 characters with no control characters. It is an upsert per endpoint: repeating it is harmless, and it moves a shared device to the user now signed in. Only the 10 newest devices per user are kept. `400 unsupported_push_service` when the endpoint is not on the Google, Mozilla, Microsoft or Apple push service.
- `DELETE /v1/push/subscriptions` with exactly one of `{"endpoint":"…"}` (one device, on logout) or `{"user_id":"…"}` (all devices, on account deletion) → `204`, even when nothing matched. It is scoped to this app, not to a user.
- `POST /v1/push/send` with an `Idempotency-Key` header (1-255 characters, unique per event) and the body `{"user_id":"…","template":"new-message","locale":"it","variables":{"appName":"…","sender":"…"},"url":"/chat/42","tag":"chat-42"}`:
  - `locale`: `it`, `en` or `pt-BR`, default `en`. `variables`: exactly `appName` and `sender`, each 1-64 characters with no control characters.
  - `url` (optional): a path on my own site, 1-512 characters, starting with a single `/`, with no `\`.
  - `tag` (optional): `^[A-Za-z0-9_-]{1,32}$`, the conversation id. Notifications with the same tag replace each other on screen. A UUID fits once its dashes are removed.
  - The device receives `{"title","body","url","tag"}`: the title is `{{appName}}`, the body "You received a notification from {{sender}}" (also in `it` and `pt-BR`).

| Outcome of `/v1/push/send` | What to do |
|---|---|
| `200 {"id":"psh_…","status":"submitted","devices":n}` | Done. A replayed Idempotency-Key returns the stored result, whose `status` may be `failed` or `processing` |
| 400 `validation_error` / `invalid_json` / `invalid_variables`, 404 `template_not_found` | It's a bug: don't retry |
| 401 `unauthorized` | Wrong configuration (URL or key) |
| 403 `push_disabled`, 503 `push_not_configured` | The operator must enable push: don't retry |
| 404 `no_subscriptions` | The user has no device: ignore it |
| 429 `rate_limited` | Drop this push: the earlier ones for the conversation are still on screen |
| 502 `push_failed` | No push service accepted it: don't retry |
| 500, timeout or network error | At most one retry with the SAME key, in the background |

- HTTP client timeout: 20 s, because the service retries each device for up to about 17 s. A push never blocks the user's request: send it after the message is saved.
- Limits: 600 requests per minute per app on `/v1/push/*`, and 60 pushes per hour per user and conversation (the tag). Failed sends don't count. A `429` on the subscription routes means retry after 60 s.

## Procedure

### 1. Analysis (without asking me anything)

Explore the repository and summarise in at most 10 lines:
- language and framework, where the backend lives, how it loads environment variables and secrets;
- how the session exposes the logged-in user's id, and where logout and account deletion happen;
- the events that should notify (new chat message, mention…), and whether a realtime channel (WebSocket, SSE…) knows which conversation a user has open and focused;
- any existing service worker, web app manifest or PWA plugin, and any existing push code (`web-push`, FCM, OneSignal…);
- where the user's language is stored, and the test framework in use.

If the app has no backend (static frontend or SPA only), stop: explain it to me and suggest the simplest option for my platform, such as an API route or a serverless function. If production isn't served over HTTPS, tell me push requires it.

### 2. Do I already have notify-flow with push?

Ask me: "Do you already have the notify-flow URL and an API key for this app, with Web Push enabled?" If I'm not sure, ask me to run `curl {URL}/v1/push/public-key -H "Authorization: Bearer <key>"` in my own terminal and tell you the status: `200` is ready, `503` means the VAPID keys are missing, `403` means push is off for this app.
- Ready: go to step 3.
- Otherwise: walk me through the "Service setup" section below, then come back here.

### 3. Plan

List the files you will create or change, the backend routes, and which event triggers which push, with which `tag` and `url`. Wait for my "ok".

### 4. Implementation

1. Add `NOTIFY_FLOW_URL`, `NOTIFY_FLOW_API_KEY` and `NOTIFY_FLOW_APP_NAME` to `.env.example` (or the project's equivalent). Check that `.env` is in `.gitignore`.
2. Create ONE backend client module with `getPublicKey()` (cached), `subscribe(userId, subscription)`, `unsubscribe({ endpoint } | { userId })` and `sendPush({ userId, sender, locale, url, tag, idempotencyKey })`. It adds `template: "new-message"` and `appName`, uses a 20 s timeout, throws an error with the HTTP status and `code`, and reports clearly at startup if environment variables are missing.
3. Backend routes, all behind the login except the key:
   - `GET /api/push/key` → `{"publicKey"}`;
   - `POST /api/push/subscribe` → `subscribe(session user, body)`, keeping a record of which endpoints each user registered;
   - `POST /api/push/unsubscribe` with `{"endpoint"}` → delete it only if the session user registered it;
   - on account deletion, `unsubscribe({ userId })`.
4. Browser, following the reference guide:
   - an "Enable notifications" button that asks for permission, subscribes with `userVisibleOnly: true` and the public key, and sends the subscription to the backend;
   - on app start and right after login, only with a session: if permission is granted, compare the current subscription's `applicationServerKey` with the public key. Same key: register it again. Different key: unsubscribe and subscribe again;
   - on logout: read the endpoint, call `unsubscribe()` in the browser, then send the endpoint to the backend.
5. Service worker: extend the app's own if there is one (Workbox, a PWA plugin…), otherwise create `sw.js` at the origin root. The `push` handler must ALWAYS call `showNotification`, even with an empty or invalid payload, because Safari revokes the subscription otherwise. Pass `tag`, `renotify: !!tag` and `data: { url }`. `notificationclick` focuses an open window on that URL or opens it, on the app's own origin only.
6. iPhone and iPad: push works only once the app is added to the Home Screen. If there is no web app manifest, create a minimal one (`name`, `icons`, `start_url`, `display: "standalone"`), and next to the button tell iOS users to add the app first.
7. Wire the events, for example a new chat message. If the recipient has that conversation open and focused on any device, deliver through the realtime channel only. Otherwise call `sendPush` with `tag` = the conversation id, `url` = the conversation's path, `sender` = the sender's display name without control characters and cut to 64 characters, and `Idempotency-Key` = `msg:<messageId>`. Without a realtime channel, push every message and rely on step 8. A failed push only logs the `id` and the code.
8. When a conversation opens, or shows a new message while focused, close its notifications: `registration.getNotifications({ tag })`, then `close()` on each.
9. Map the user's language to `it`/`en`/`pt-BR`, falling back to `en`.
10. If there is old push code, replace it. Ask me before removing dependencies and keys that are no longer needed.

### 5. Verification

- Write unit tests for the client module with mocked HTTP: `200`, `404 no_subscriptions` ignored, `429`, `502` and timeout. Also check that the key and the endpoint never appear in logs.
- Test the backend routes: `subscribe` uses the session user and ignores any `user_id` in the body, `unsubscribe` refuses an endpoint the user didn't register, and every route except the key needs a login.
- Run the project's existing tests, lint and typecheck, and fix whatever you break.
- Give me a manual test to run myself over HTTPS (or on `localhost`): enable notifications, close the chat, send a message from another account, see the notification, tap it to open the chat, then log out and check that no more arrive. On iPhone, add the app to the Home Screen first.

### 6. Final report

Show me a table with:
- the files changed;
- the wired events (event → `tag` and `url`);
- what I still have to do (e.g. set the secrets in production, enable push for the app);
- a production checklist with ✅/❌: key in the backend only, `user_id` from the session, permission asked after a click, service worker always shows a notification, no push while the conversation is open, Idempotency-Key per event, valid tag, logout and account deletion remove devices, no endpoints or keys in logs, manual test done.

Finally, tell me that transactional email (sign-up, password reset…) can be added later with this prompt: https://github.com/yintong-zhou/notify-flow/blob/main/docs/ai-integration-prompt.md

## Service setup (only if I don't have it)

Steps marked "Me:" are mine; you run all the others, in a folder OUTSIDE this repository. If notify-flow is already deployed (for example for email), work in its folder and start from step 5.

1. `git clone https://github.com/yintong-zhou/notify-flow && cd notify-flow && npm install && cp wrangler.jsonc.example wrangler.jsonc`
2. Me: `npx wrangler login`
3. `npx wrangler d1 create notify-flow`, then copy the `database_id` into `wrangler.jsonc`. Create the queue with `npx wrangler queues create notify-flow-emails`: the deploy fails without it, even when email is unused.
4. Me: `npx wrangler secret put ADMIN_SETUP_TOKEN` with a long random string. notify-flow also lists `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` and `SMTP_FROM_NAME` as required secrets: since I don't use email, I set each one to `unused`. Email sends would fail, and push is unaffected.
5. Me, in MY OWN terminal: `npm run push:keys`. It prints a public and a private key. I store the private key with `npx wrangler secret put VAPID_PRIVATE_KEY`, keep a copy in a password manager, and give you the PUBLIC key only.
6. In `wrangler.jsonc`, set the vars `VAPID_PUBLIC_KEY` (the public key) and `VAPID_SUBJECT` (ask me for a `mailto:` address). Remind me never to rotate these keys: every browser would have to subscribe again.
7. `npm run db:migrate:remote` (confirm with `y`), then `npm run deploy`. Give me the `https://notify-flow.<subdomain>.workers.dev` URL and check that `GET /health` answers `{"status":"ok"}`.
8. Me, in MY OWN terminal, unless this app already has a key: `npm run client:create -- <app-name> --remote`. I copy the key into my `.env` or secret manager.
9. Switch push on for the app: `npx wrangler d1 execute notify-flow --remote --command "UPDATE clients SET push_enabled = 1 WHERE name = '<app-name>'"`, or the **Clients** panel of `/admin/`. Then ask me to run the `curl` from step 2: `200` means push is ready.
````

# Web Push Plan — Part 3: Task 3

[← Part 2](2026-10-25-web-push-part2.md) · [Part 4 →](2026-10-25-web-push-part4.md)

## Task 3: `POST /v1/push/send`

**Files:**
- Create: `src/push/templates.ts`, `src/push/sender.ts`, `test/push-send.test.ts`
- Modify:
  - `src/push/validation.ts`
  - `src/push/routes.ts`
  - `src/templates/renderer.ts`
  - `src/index.ts`
  - `test/helpers.ts`

**Interfaces:**
- Consumes:
  - from Task 1: `encryptPayload`, `vapidAuthorization`, `b64url`, `browserKeys`, `decryptPush`;
  - from Task 2: `vapidKeys`, `listSubscriptions`, `deleteSubscription`, `handlePush`'s route table, `pushCall`, `enablePush`, `pushEnv`;
  - existing: `SendOptions` (`services/email-service.ts`), `log()`, `parseIdempotencyKey`, `readJson`, `HttpError`, `isLocale`.
- Produces:
  - `sendPush` and `purgePushDeliveries` (Part 1 signatures);
  - in `src/push/templates.ts`:
    - `PushTemplate { title: string; body: string; variables: string[] }`
    - `resolvePushTemplate(name: string, locale: Locale): PushTemplate`
    - `renderPush(t: PushTemplate, vars: Record<string, string>): { title: string; body: string }`
  - `parsePushRequest(body: Record<string, unknown>): PushRequest`;
  - in `test/helpers.ts`: `pushRecorder(script: Record<string, Array<number | Error>> = {})`, returning `{ fetch: PushFetch; requests: { url: string; headers: Headers; body: Uint8Array }[] }`. Each call to a URL consumes that URL's next outcome. A number answers with that status, an `Error` rejects, and an empty script answers `201`.

- [ ] **Step 1: Write the failing tests** in `test/push-send.test.ts`.

  **Setup.** Each test uses a fresh enabled client. It registers its devices through `PUT /v1/push/subscriptions` with keys from `browserKeys()`, so payloads can be decrypted. The defaults:
  - `E1 = "https://fcm.googleapis.com/fcm/send/1"` and `E2 = "https://updates.push.services.mozilla.com/wpush/v2/2"`;
  - `BODY = { user_id: "u1", template: "new-message", locale: "it", variables: { appName: "Piattaforma XX", sender: "Marco" }, url: "/chat/42", tag: "chat-42" }`;
  - `send(key, body, rec, headers?, testEnv = pushEnv)` posts to `/v1/push/send`;
  - tests register only `E1` unless they say "two devices".

  **Tests:**
  - **`"sends the base template to every device of the user"`:** two devices, `pushRecorder()`.
    - **Response:** `200` with `{ id: expect.stringMatching(/^psh_/), status: "submitted", devices: 2 }`.
    - **Requests:** 2. Each has `TTL` `"86400"`, `Urgency` `"high"`, `Topic` `"chat-42"`, `Content-Encoding` `"aes128gcm"`, and `Authorization` matching `` new RegExp(`^vapid t=[^,]+, k=${VAPID_TEST.publicKey}$`) ``.
    - **Payload:** each `decryptPush` result parses to exactly `{ title: "Piattaforma XX", body: "Hai ricevuto una notifica da Marco", url: "/chat/42", tag: "chat-42" }`.
    - **Row:** `submitted`, `devices` 2, `tag` `"chat-42"`, `sent_at` not null.
  - **`"falls back to en and omits url, tag and Topic when not given"`:**
    - without `locale`, `url` and `tag`, the payload is exactly `{ title: "Piattaforma XX", body: "You received a notification from Marco" }`, with no `Topic` header;
    - with `locale: "pt-BR"`, the body is `"Você recebeu uma notificação de Marco"`.
  - **`"keeps non-ASCII values intact"`** (Review Focus 3): `sender: "Zoë 🙂"` gives the body `"Hai ricevuto una notifica da Zoë 🙂"`.
  - **`"validates the request"`** (Review Focus 2).
    - These give `400 validation_error`:
      - `template: "New"`, `locale: "fr"`, `user_id: ""`;
      - `variables: null`, `variables: { appName: "X", sender: 5 }`;
      - a value of `""`, of 65 `"a"`s, or of `"a\nb"`;
      - `url` set to `"//evil.com"`, `"https://evil.com"`, `"/a\\b"`, `5`, or `"/" + "a".repeat(512)`;
      - `tag` set to `"has space"` or to 33 characters.
    - `variables: { appName: "X" }` gives `400 invalid_variables`.
    - `template: "welcome"` gives `404 template_not_found`: email templates are not push templates.
  - **`"answers 404 no_subscriptions without writing a row"`:** for an unknown user, `push_deliveries` has 0 rows for the client.
  - **`"replays an Idempotency-Key without sending again"`:** one device. Two sends with `Idempotency-Key: k1` return equal bodies, and `requests.length === 1`.
  - **`"limits pushes per user and conversation per hour"`:** with `{ ...pushEnv, PUSH_LIMIT_PER_HOUR: "2" }`:
    - `tag` `"a"` twice gives `200`, and a third time gives `429 rate_limited`;
    - `tag` `"b"` gives `200`, and so does an untagged send;
    - failed rows don't count. With `pushRecorder({ [E1]: [400, 400] })`, two sends with `tag` `"c"` give `502`, and a third gives `200`.
  - **`"removes subscriptions the push service reports gone"`:** with `{ [E1]: [410] }` the send gives `200` with `devices: 1`. `E1`'s row is gone and `E2`'s row stays.
  - **`"retries transient failures"`:** with `{ [E1]: [503, 429] }` the send gives `200` after 3 requests. `app_logs` has `push_attempt_failed` rows with `message_id` = id and details `"HTTP 503 attempt 1/3"` and `"HTTP 429 attempt 2/3"`.
  - **`"gives up after three timeouts"`** (Review Focus 4): with `{ [E1]: [t, t, t] }` and `t = new DOMException("timeout", "TimeoutError")`:
    - the send gives `502 push_failed` with `id`;
    - the row is `failed` with `push_failed`;
    - the logs read `"network attempt 1/3"` to `"network attempt 3/3"`.
  - **`"answers 404 push_expired when every device is gone"`:** with `{ [E1]: [404], [E2]: [410] }` the send gives `404 no_subscriptions` with `id`. The row is `failed` with `push_expired`, and no subscriptions remain.
  - **`"answers 502 when every device rejects"`:** with `{ [E1]: [403] }` the send gives `502 push_failed`. The row is `failed`/`push_failed` and the subscription is kept.
  - **`"never stores or logs content"`:** `sender: "Marco-SECRET"`, `url: "/chat/SECRET-URL"` and `{ [E1]: [503] }`. Then `JSON.stringify` of every `push_deliveries` and `app_logs` row contains neither `"SECRET"` nor `E1`.
  - **`"purges old deliveries and closes abandoned ones"`:**
    - insert a `submitted` row created 31 days ago, a `processing` row from 301 s ago, and a `processing` row from now;
    - call `purgePushDeliveries(env.DB)`;
    - the first is deleted, the second becomes `failed`/`abandoned`, and the third is unchanged.
- [ ] **Step 2: Run** `npx vitest run test/push-send.test.ts`. Expected: FAIL (route `send` not found).
- [ ] **Step 3: Renderer and templates.**
  - In `renderer.ts`, export `fill`, and type `checkVariables` as `(template: Pick<Template, "variables">, vars)`.
  - `templates.ts` holds `new-message` with variables `["appName", "sender"]`, title `{{appName}}` and the three bodies from the spec part 2 table, verbatim.
  - `resolvePushTemplate` tries `locale`, then `"en"`, otherwise `404 template_not_found` "Template \"<name>\" not found".
  - `renderPush` calls `fill` with identity encoding.
- [ ] **Step 4: `parsePushRequest`.** Apply the Global Constraints limits. `url` and `tag` appear in the result only when given.
- [ ] **Step 5: `sendPush`** in `src/push/sender.ts`, following the spec part 2 flow, steps 1-8:
  - **Template:** resolve the template, then `checkVariables`.
  - **Replay:** `SELECT id, status, devices FROM push_deliveries WHERE client_id = ? AND idempotency_key = ?`.
  - **Subscriptions:** `listSubscriptions`. None means `404 no_subscriptions` before any row.
  - **Reserve:** id `psh_<uuid>`, same pattern as `reserveDelivery`. The `INSERT … SELECT … WHERE (count) < ?` counts the user's non-failed rows from the last hour of the same conversation: `(?tag IS NULL AND tag IS NULL AND template = ?template) OR tag = ?tag`. It ends with `ON CONFLICT (client_id, idempotency_key) DO NOTHING`. On 0 changes, replay, otherwise `429 rate_limited` "Too many push notifications for this user and conversation".
  - **Payload:** `JSON.stringify({ title, body, url, tag })`. Undefined keys drop out.
  - **Delivery:** all devices in parallel. For each device, encrypt once, then make up to 3 fetch attempts with `signal: AbortSignal.timeout(5000)` and the Global Constraints headers. The outcome is `accepted`, `gone` (`deleteSubscription`) or `failed`, and every failed attempt is logged.
  - **Close:** close the row as the spec says. The `submitted` `UPDATE` runs after the sends, outside any catch.
- [ ] **Step 6: Route and cron.**
  - Add `send: { POST: gated(send) }` to `routes.ts`. The handler parses `Idempotency-Key` before the body.
  - `requestId = cf-ray ?? uuid`.
  - `ctx?.waitUntil(result.catch(() => {}))`, as `dispatch` does.
  - Add `purgePushDeliveries(env.DB)` to `scheduled` in `src/index.ts`.
  - `purgePushDeliveries` first closes rows `processing` for more than 300 s (`ABANDONED_AFTER_S`), then deletes rows older than 30 days in batches of 1000, like `purgeDeliveries`.
- [ ] **Step 7: Run** `npx vitest run test/push-send.test.ts`, then `npm test`, then `npm run typecheck`. Expected: all pass.
- [ ] **Step 8: Commit:** `git add src test && git commit -m "feat(push): templated send with VAPID, retries and hourly limit"`

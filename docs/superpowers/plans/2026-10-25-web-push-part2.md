# Web Push Plan — Part 2: Tasks 1 and 2

[← Part 1](2026-10-25-web-push.md) · [Part 3 →](2026-10-25-web-push-part3.md)

## Task 1: Push crypto (RFC 8291 encryption, RFC 8292 VAPID)

**Files:**
- Create: `src/push/crypto.ts`, `test/push-crypto.test.ts`
- Modify: `test/helpers.ts` (append `browserKeys`, `decryptPush`)

**Interfaces:**
- Consumes: nothing.
- Produces: everything under `// src/push/crypto.ts` in [Part 1, Shared interfaces](2026-10-25-web-push.md#shared-interfaces). Also, in `test/helpers.ts`:
  - `browserKeys(): Promise<{ privateKey: CryptoKey; p256dh: string; auth: string }>`, which generates an ECDH P-256 pair and 16 random bytes and returns them base64url-encoded;
  - `decryptPush(body: Uint8Array, browser: { privateKey: CryptoKey; auth: string }): Promise<string>`.

- [ ] **Step 1: Write the failing tests** in `test/push-crypto.test.ts`. The constants are the RFC 8291 §5 example, verbatim:

```ts
const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const EXPECTED =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
const enc = (s: string) => new TextEncoder().encode(s);

it("reproduces the RFC 8291 example byte for byte", async () => {
  const asPublic = b64url.decode(AS_PUBLIC);
  const ephemeral = { privateKey: await importPrivateKey(b64url.decode(AS_PRIVATE), asPublic, "ECDH"), publicRaw: asPublic, salt: b64url.decode(SALT) };
  const out = await encryptPayload(enc("When I grow up, I want to be a watermelon"), b64url.decode(UA_PUBLIC), b64url.decode(AUTH), ephemeral);
  expect(b64url.encode(out)).toBe(EXPECTED);
});

it("derives the RFC 8291 appendix A key and nonce", async () => {
  const keys = await deriveKeys(b64url.decode("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs"), b64url.decode(AUTH),
    b64url.decode(UA_PUBLIC), b64url.decode(AS_PUBLIC), b64url.decode(SALT));
  expect(b64url.encode(keys.cek)).toBe("oIhVW04MRdy2XN9CiKLxTg");
  expect(b64url.encode(keys.nonce)).toBe("4h_95klXJ5E_qnoN");
});

it("encrypts with a fresh key and salt that the browser can decrypt", async () => {
  const browser = await browserKeys();
  const [a, b] = await Promise.all([1, 2].map(() => encryptPayload(enc("hello"), b64url.decode(browser.p256dh), b64url.decode(browser.auth))));
  expect(await decryptPush(a, browser)).toBe("hello");
  expect(a.length).toBe(86 + 5 + 1 + 16); // header + plaintext + 0x02 delimiter + GCM tag
  expect(b64url.encode(a.slice(0, 16))).not.toBe(b64url.encode(b.slice(0, 16))); // new salt per message
});

it("signs an ES256 VAPID JWT for the endpoint origin", async () => {
  const keys = { publicKey: AS_PUBLIC, privateKey: AS_PRIVATE, subject: "mailto:ops@example.com" };
  const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, 1_700_000_000_000);
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
  expect(k).toBe(AS_PUBLIC);
  const [h, c, s] = t.split(".");
  const json = (part: string) => JSON.parse(new TextDecoder().decode(b64url.decode(part)));
  expect(json(h)).toEqual({ typ: "JWT", alg: "ES256" });
  expect(json(c)).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_700_000_000 + 43200, sub: "mailto:ops@example.com" });
  const pub = await crypto.subtle.importKey("raw", b64url.decode(AS_PUBLIC), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64url.decode(s), enc(`${h}.${c}`))).toBe(true);
});

it("b64url.decode rejects anything but unpadded base64url", () => {
  for (const bad of ["a+b/", "ab c", "ab=="]) expect(() => b64url.decode(bad)).toThrow();
});
```

- [ ] **Step 2: Run** `npx vitest run test/push-crypto.test.ts`. Expected: FAIL, because `src/push/crypto.ts` does not exist.
- [ ] **Step 3: Implement `src/push/crypto.ts`** with the Part 1 signatures. Everything goes through WebCrypto only.
  - **`b64url`:** check `^[A-Za-z0-9_-]*$` before `atob`.
  - **`importPrivateKey`:** a JWK `{kty:"EC", crv:"P-256", x: publicRaw[1..33], y: publicRaw[33..65], d}`. Usages are `["deriveBits"]` for ECDH and `["sign"]` for ECDSA.
  - **`deriveKeys`:** RFC 8291 §3.4 pseudocode, either as HMAC-SHA-256 steps or with WebCrypto `HKDF`:
    - `IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0" ‖ ua ‖ as, 32)`;
    - `CEK = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16)`;
    - `NONCE = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12)`.
  - **`encryptPayload`:**
    - The default ephemeral is a new ECDH pair (raw public export) plus a 16-byte random salt.
    - `ecdh = deriveBits(ECDH with p256dh as public, 256)`.
    - Output: header `salt ‖ uint32 BE 4096 ‖ 0x41 ‖ publicRaw`, then `AES-GCM(cek, nonce)` over `plaintext ‖ 0x02`.
  - **`vapidAuthorization`:**
    - JWT `b64url(header).b64url(claims)`, signed with `{name:"ECDSA", hash:"SHA-256"}`. WebCrypto already returns the 64-byte `r‖s` that JOSE expects.
    - `aud = new URL(endpoint).origin`.
    - `exp = Math.floor(nowMs / 1000) + 43200`, with `nowMs` defaulting to `Date.now()`.
    - Returns `vapid t=<jwt>, k=<publicKey>`.
- [ ] **Step 4: Add `browserKeys` and `decryptPush` to `test/helpers.ts`.** `decryptPush` reads:
  - `salt = body[0..16]`;
  - `asPublic = body[21..86]`;
  - ECDH from `browser.privateKey` and `asPublic`;
  - then `deriveKeys`, AES-GCM decrypt of `body[86..]`, drop the trailing `0x02`, and UTF-8 decode.
- [ ] **Step 5: Run** `npx vitest run test/push-crypto.test.ts`, then `npm run typecheck`. Expected: 5 passed, no type errors.
- [ ] **Step 6: Commit:** `git add src/push/crypto.ts test/push-crypto.test.ts test/helpers.ts && git commit -m "feat(push): RFC 8291 encryption and VAPID signing"`

## Task 2: Schema, config and the subscriptions API

**Files:**
- Create:
  - `migrations/0008_push.sql`
  - `src/push/validation.ts`
  - `src/push/subscriptions.ts`
  - `src/push/routes.ts`
  - `test/push-subscriptions.test.ts`
- Modify:
  - `src/security/rate-limit.ts`
  - `src/index.ts`
  - `test/helpers.ts`
  - `wrangler.jsonc.example`
  - `wrangler.jsonc`
  - `.dev.vars.example`

**Interfaces:**
- Consumes: `b64url` and `VapidKeys` (Task 1).
- Produces:
  - **`src/push/subscriptions.ts`, `src/push/routes.ts`, and `vapidKeys`/`pushConfigured` in `src/push/crypto.ts`:** the Part 1 signatures. `handlePush` has a `ROUTES` table that Task 3 extends with `send`.
  - **`src/push/validation.ts`:**
    - `parseUserId(raw: unknown): string`
    - `parseSubscription(body): { userId: string; sub: Subscription }`
    - `parseUnsubscribe(body): { endpoint: string } | { userId: string }`
  - **`src/security/rate-limit.ts`:** `checkPushLimit(env: Env, clientId: string): Promise<void>`.
  - **`test/helpers.ts`:**
    - `VAPID_TEST = { publicKey, privateKey }`: the RFC sender pair, the Task 1 `AS_PUBLIC`/`AS_PRIVATE`;
    - `pushEnv: Env`: `{ ...env }` plus `VAPID_TEST` as `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` and `VAPID_SUBJECT: "mailto:ops@example.com"`;
    - `enablePush(clientId: string, on = true): Promise<void>`;
    - `pushCall(path, init = {}, fetchPush: PushFetch = accept, testEnv = pushEnv)`, where `accept` answers `201`. It calls `handle(req, testEnv, async () => {}, undefined, fetchPush)` and shares request building with `call`.

- [ ] **Step 1: Write the failing tests** in `test/push-subscriptions.test.ts`. Use `sub(endpoint)` = `{ endpoint, keys: { p256dh: UA_PUBLIC, auth: AUTH } }` with the RFC values from Task 1, and a client created with `createClient()` then `enablePush(id)`. Every test below states the exact expectation:
  - **`"answers 503 push_not_configured without VAPID settings"`:** `GET /v1/push/public-key`, run once with `{ ...pushEnv, VAPID_PUBLIC_KEY: "" }` and once with `VAPID_PRIVATE_KEY: ""`, gives `503` with `error.code === "push_not_configured"`.
  - **`"answers 403 push_disabled until the client enables push"`:** without `enablePush`, `GET /v1/push/public-key` gives `403 push_disabled`.
  - **`"DELETE works when push is disabled or not configured"`:** `DELETE {user_id:"u1"}` gives `204` on a disabled client, and again with `VAPID_PUBLIC_KEY: ""`.
  - **`"routes unknown push paths and wrong methods before the gates"`** (Review Focus 5): on a disabled client, `GET /v1/push/nope` gives `404 not_found` and `GET /v1/push/subscriptions` gives `405`.
  - **`"push routes use PUSH_RATE_LIMITER, not CLIENT_RATE_LIMITER"`:** with `deny = { limit: async () => ({ success: false }) }`:
    - `GET /v1/push/public-key` with `CLIENT_RATE_LIMITER: deny` gives `200`;
    - the same call with `PUSH_RATE_LIMITER: deny` gives `429 rate_limited`;
    - `call("/v1/templates")` with `PUSH_RATE_LIMITER: deny` gives `200`.
  - **`"returns the VAPID public key"`:** the body is `{ public_key: VAPID_TEST.publicKey }`.
  - **`"registers, moves and caps subscriptions"`:**
    - `PUT {user_id:"u1", subscription: sub(E)}` gives `204` and one row `(E, "u1")`;
    - `PUT` of `E` again for `"u2"` leaves one row `(E, "u2")`;
    - 11 `PUT`s of `…/e0`…`…/e10` for `"u3"` keep exactly `e1`…`e10`.
  - **`"accepts every allowlisted push service"`:** each of these gives `204`:
    - `https://fcm.googleapis.com/fcm/send/x`
    - `https://updates.push.services.mozilla.com/wpush/v2/x`
    - `https://wns2-par02p.notify.windows.com/w/?token=x`
    - `https://web.push.apple.com/x`
  - **`"rejects endpoints outside the allowlist"`:** `https://fcm.googleapis.com.evil.com/x` and `https://evil.com/x` give `400 unsupported_push_service`. These give `400 validation_error`: `http://fcm.googleapis.com/x`, `https://fcm.googleapis.com:8443/x`, `https://u:p@fcm.googleapis.com/x`, `"not a url"`, and `"https://fcm.googleapis.com/" + "a".repeat(2030)`.
  - **`"rejects bad keys and malformed bodies"`** (Review Focus 2): each of these gives `400 validation_error`:
    - `p256dh` of 64 bytes;
    - `p256dh` with first byte `0x03`;
    - `auth` of 15 bytes, and `auth: "a+b/"`;
    - `subscription: null`, and `keys: "x"`;
    - `user_id` set to `""`, to 129 characters, or to `"a\nb"`.
  - **`"keeps the same endpoint separate per client"`** (Review Focus 1): clients A and B `PUT` the same endpoint. After B sends `DELETE {endpoint}`, A's row is still there.
  - **`"deletes one device by endpoint or all by user_id"`:** both forms give `204` and the matching rows are gone. `DELETE {}` and `DELETE {endpoint, user_id}` give `400 validation_error`.
- [ ] **Step 2: Run** `npx vitest run test/push-subscriptions.test.ts`. Expected: FAIL (missing modules and table).
- [ ] **Step 3: Config.** Make these changes in both `wrangler.jsonc.example` and `wrangler.jsonc`:
  - `IP_RATE_LIMITER` limit `600`, with its comment updated to cover push;
  - a new `PUSH_RATE_LIMITER` (`namespace_id` `"1005"`, `{ "limit": 600, "period": 60 }`), commented as "Per-client limit on /v1/push/*, separate so chat traffic never blocks email";
  - vars `VAPID_PUBLIC_KEY: ""` and `VAPID_SUBJECT: ""`, both commented with "empty = push off", plus `PUSH_LIMIT_PER_HOUR: "60"`;
  - in the secrets comment, `VAPID_PRIVATE_KEY`, marked optional and from `npm run push:keys`.

  Add `VAPID_PRIVATE_KEY=` to `.dev.vars.example`.
- [ ] **Step 4: Create `migrations/0008_push.sql`**, copying the SQL block from spec part 1 verbatim.
- [ ] **Step 5: Implement** `checkPushLimit`, the three parsers, `subscriptions.ts` and `routes.ts`:
  - **Rate limit:** `checkPushLimit` mirrors `checkClientLimit`, with the message "Too many push requests for this client".
  - **Upsert:** `upsertSubscription` runs, in one `db.batch`, an `INSERT … ON CONFLICT (client_id, endpoint) DO UPDATE` of `user_id, p256dh, auth, created_at`. It then deletes the user's rows not among the 10 newest.
  - **Routes table:** `handlePush` resolves the route via an `Object.hasOwn` table (`"public-key": {GET}`, `subscriptions: {PUT, DELETE}`). A miss answers `404 not_found` "Route not found". A wrong method answers `405 method_not_allowed` "Allowed methods: …". Same pattern as `handleAdmin`.
  - **Gates:** the gated handlers check, in order:
    - `pushConfigured`, otherwise `503` "Web Push is not configured on this service";
    - then `SELECT push_enabled FROM clients WHERE id = ?`, otherwise `403` "Web Push is not enabled for this client".
  - **VAPID settings:** add `vapidKeys` and `pushConfigured` to `src/push/crypto.ts`, not to `routes.ts`, because Task 3's `sender.ts` needs them and `routes.ts` will import `sender.ts`. `vapidKeys` reads `VAPID_PRIVATE_KEY` through `env as unknown as Record<string, string | undefined>`, because an optional secret is not in the generated `Env`. Say so in a one-line comment.
- [ ] **Step 6: Wire `src/index.ts`.**
  - Add `fetchPush: PushFetch = fetch` as the 5th parameter of `handle`.
  - After `authenticate`, `const push = pathname.startsWith("/v1/push/")` chooses `checkPushLimit` or `checkClientLimit`.
  - If `push`, `return await handlePush(req, env, clientId, pathname.slice("/v1/push/".length), fetchPush, ctx)`.
  - Then add `pushEnv`, `enablePush` and `pushCall` to `test/helpers.ts`.
- [ ] **Step 7: Run** `npx vitest run test/push-subscriptions.test.ts`, then `npm test`, then `npm run typecheck`. Expected: all pass, and the existing suites are unchanged.
- [ ] **Step 8: Commit:** `git add migrations/0008_push.sql src test wrangler.jsonc.example .dev.vars.example && git commit -m "feat(push): opt-in gates and subscriptions API"`

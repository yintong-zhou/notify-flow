# Web Push Plan — Part 4: Tasks 4 and 5

[← Part 3](2026-10-25-web-push-part3.md)

## Task 4: Admin Clients panel with the push switch

**Files:**
- Modify: `src/admin/routes.ts`, `public/admin/index.html`, `public/admin/app.js`
- Create: `test/admin-clients.test.ts`

**Interfaces:**
- Consumes:
  - `pushConfigured` (`src/push/crypto.ts`, Task 2);
  - `withSession`, `requireJson`, `readJson` and `invalid` (existing);
  - `adminCall`, `setupAdmin`, `createClient`, `pushEnv` and `pushCall` (test helpers).
- Produces:
  - `GET /admin/api/clients` → `{ push_configured: boolean, clients: [{ id, name, created_at, push_enabled: boolean, push_devices: number }] }`, sorted by name;
  - `POST /admin/api/client-push` `{ client_id: string, enabled: boolean }` → `204`.

- [ ] **Step 1: Write the failing tests** in `test/admin-clients.test.ts`:
  - **`"requires a session"`:** both routes without a cookie give `401`.
  - **`"lists clients with push state and device count"`:**
    - create client `"shop"`, enable push, and register 2 devices via `pushCall`;
    - `adminCall("clients", { cookie }, pushEnv)` gives `200`, with `push_configured: true` and `clients` containing `{ id, name: "shop", created_at: expect.any(Number), push_enabled: true, push_devices: 2 }`;
    - with the default `env` (empty VAPID vars), `push_configured` is `false`.
  - **`"toggles push for a client"`:** `{ client_id, enabled: true }` with `pushEnv` gives `204` and `push_enabled` 1. `{ enabled: false }` gives `204` and 0.
  - **`"refuses to enable push when it is not configured"`:** with the default `env`, `enabled: true` gives `409 push_not_configured`, while `enabled: false` gives `204`.
  - **`"validates the toggle"`:**
    - an unknown `client_id` gives `404 not_found`;
    - `enabled: "yes"` or a missing `client_id` gives `400 validation_error`;
    - a body without `Content-Type: application/json` gives `415`.
- [ ] **Step 2: Run** `npx vitest run test/admin-clients.test.ts`. Expected: FAIL (`404` routes).
- [ ] **Step 3: Implement both handlers** in `src/admin/routes.ts` and add them to `ROUTES`: `clients: { GET: withSession(clients) }` and `"client-push": { POST: withSession(clientPush) }`.
  - **List:** the query counts `push_subscriptions` per client with a subquery, and `push_enabled` is mapped to a boolean.
  - **Toggle:** `clientPush` checks, in this order:
    1. `requireJson`;
    2. validation;
    3. `409` "Web Push is not configured on this service" when `enabled && !pushConfigured(env)`;
    4. the `UPDATE`;
    5. `404` "Client not found" when `changes === 0`.
- [ ] **Step 4: UI.**
  - **`index.html`:** a `Clients` panel (`section.panel.p-wide`) before Database, containing:
    - `<p id="push-hint" hidden>`: "Web Push is not configured: see setup.", linking to `https://notify-flow-docs.pages.dev/admin-dashboard#web-push`;
    - `<table id="clients">` with the columns Name, Id, Created, Push devices, Push.
  - **`app.js`:** `loadClients()` runs from `refresh()`.
    - It sets `#push-hint.hidden = push_configured` and renders the rows with `el()`/`textContent` only.
    - The Push cell is a checkbox with `aria-label` `"Push for <name>"`. It is disabled when `!push_configured && !push_enabled`, so turning push off always stays possible.
    - On change it calls `api("client-push", { client_id, enabled })` and reloads. On error it calls `showError` and restores the checkbox.
- [ ] **Step 5: Check by hand.** Run `npm run dev`, open `/admin/`, and toggle a client. The switch persists after Refresh, and the hint shows while the VAPID vars are empty.
- [ ] **Step 6: Run** `npx vitest run test/admin-clients.test.ts`, then `npm test`, then `npm run typecheck`. Expected: all pass.
- [ ] **Step 7: Commit:** `git add src/admin public/admin test/admin-clients.test.ts && git commit -m "feat(admin): clients panel with per-client push switch"`

## Task 5: Key script and documentation

**Files:**
- Create:
  - `scripts/vapid-keys.mjs`
  - `docs/api-reference-push.md`
  - `docs/web-app-integration-push.md`
- Modify:
  - `package.json`
  - `docs/api-reference.md`
  - `docs/web-app-integration.md`
  - `docs/.vitepress/config.mts`
  - `docs/ai-integration-prompt.md`
  - `docs/ai-management-page-prompt.md`
  - `docs/admin-dashboard.md`
  - `README.md`
  - `CLAUDE.md`

**Interfaces:**
- Consumes: the behavior from Tasks 2-4, and spec part 2's "API", "Built-in push template", "Configuration" and "Frontend reference" sections.
- Produces: `npm run push:keys`, plus the docs pages linked from the sidebar.

- [ ] **Step 1: `scripts/vapid-keys.mjs`.**
  - Generate the pair with `generateKeyPairSync("ec", { namedCurve: "prime256v1" })` from `node:crypto`, and export both keys as JWK.
  - The public key is base64url of `0x04 ‖ x ‖ y`, and the private key is `jwk.d`.
  - The script prints both, plus `npx wrangler secret put VAPID_PRIVATE_KEY` and a reminder to set `VAPID_SUBJECT`.
  - Add `"push:keys": "node scripts/vapid-keys.mjs"` to `package.json`.
- [ ] **Step 2: Check the script.** Run `npm run push:keys` twice. Expected: a public key of 87 characters starting with `B`, a private key of 43 characters, and different values on each run.
- [ ] **Step 3: `docs/api-reference-push.md`.**
  - **Content:** the contract in spec part 2's "API" section (routes, bodies, validation, responses, error codes), the built-in template table, and a first line saying that push is opt-in and that the operator enables it per client.
  - **Links:** from the `docs/api-reference.md` overview, and from the sidebar under API Reference as `{ text: "Web Push", link: "/api-reference-push" }`.
- [ ] **Step 4: `docs/web-app-integration-push.md`.**
  - **Content:** spec part 2's "Frontend reference", points 1-7, as copyable code:
    - subscribe on click, the start-up check comparing `applicationServerKey`, and logout;
    - the service worker's `push` and `notificationclick` handlers, with `push` always calling `showNotification`;
    - the page closing a conversation's notifications by `tag`;
    - the backend "chat open, so no push" rule as pseudo-code.
  - **Notes:** the iPhone Home Screen requirement, and Safari's "visible notification for every push" rule.
  - **Links:** from `docs/web-app-integration.md`, and from the sidebar under Integration guide as `{ text: "Web Push", link: "/web-app-integration-push" }`.
- [ ] **Step 5: API contract copies.** Add the push endpoints, marked opt-in, to the "What notify-flow offers" section of `docs/ai-integration-prompt.md` and `docs/ai-management-page-prompt.md`.
- [ ] **Step 6: `docs/admin-dashboard.md`.** Add the Clients panel. Add a `## Web Push` section, anchor `#web-push`, with the operator setup steps:
  1. `npm run push:keys`;
  2. set `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` in `wrangler.jsonc`;
  3. `npx wrangler secret put VAPID_PRIVATE_KEY`;
  4. `npm run db:migrate:remote`;
  5. deploy;
  6. switch push on per client.

  Add the warning not to rotate the keys.
- [ ] **Step 7: `README.md` and `CLAUDE.md`.**
  - **README:** remove the "Web Push notifications" roadmap bullet. Add one line that links to the push docs with an absolute URL, so no relative links end up inside `#region` blocks. Stay under 200 lines.
  - **CLAUDE.md, Architecture:** a "Push (`/v1/push/*`, opt-in per client)" paragraph naming `src/push/` and the flow.
  - **CLAUDE.md, Configuration:** the optional secret `VAPID_PRIVATE_KEY`, and the vars `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` and `PUSH_LIMIT_PER_HOUR`.
  - **CLAUDE.md, Rate limiting:** 600 per IP, `PUSH_RATE_LIMITER` 600 per client on `/v1/push/*`, and `PUSH_LIMIT_PER_HOUR` per client, user and conversation.
  - **CLAUDE.md, Logs:** `push_deliveries` follows the same no-content rule.
  - **CLAUDE.md, Docs list:** the two new pages.
  - **CLAUDE.md, Testing note:** `pushCall()` and `pushRecorder()`.
  - **CLAUDE.md, roadmap:** remove Web Push.
- [ ] **Step 8: Verify.**
  - `npm run docs:build` passes, with no dead links.
  - `wc -l` on every touched `.md` shows each under 200.
  - `npm test` and `npm run typecheck` pass.
- [ ] **Step 9: Commit:** `git add scripts package.json docs README.md CLAUDE.md && git commit -m "docs(push): setup, API reference and web app integration"`

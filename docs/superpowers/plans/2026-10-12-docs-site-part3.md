# Docs Site Plan — Part 3: endpoint pages, deduplication, side updates

[← Part 2](2026-10-12-docs-site-part2.md) · [Part 1](2026-10-12-docs-site.md)

## Task 3 (continued): endpoint pages

**`api-reference-email.md` — Sending**

- **`## POST /v1/email/send`** sends a template now, or queues it with `Prefer: respond-async`.

  | Field | Rule |
  |---|---|
  | `template` | required, `^[a-z0-9-]{1,64}$` |
  | `to` | required, one address of at most 254 characters, no spaces, commas, `<>()[]\;:@"` or line breaks; stored lowercased |
  | `locale` | optional: `it`, `en` or `pt-BR`, default `en` |
  | `variables` | required: an object whose values are all strings, whose keys equal the template's declared list (`400 invalid_variables` otherwise) |

  - **Template lookup:** the client's template in `locale`, then the built-in in `locale`, then the same two in `en`. If none exists → `404 template_not_found`.
  - **Responses:**
    - `200 {"id":"msg_…","status":"submitted"}`;
    - `202` queued;
    - a replay gets the stored result;
    - `502 smtp_failed` with `id`; the message says "may still be delivered" when the server never confirmed;
    - `500 smtp_misconfigured`.
  - Add a table of the built-in templates and their variables:
    - `welcome` and `password-changed`: `appName`, `name`;
    - `verify-email`: `appName`, `name`, `verifyUrl`;
    - `password-reset`: `appName`, `name`, `resetUrl`;
    - `login-alert`: `appName`, `name`, `device`, `ipAddress`, `time`;
    - `generic-notification`: `appName`, `title`, `message`.
- **`## GET /v1/email/:id`** (use `:param` path syntax in every heading: VitePress reads a trailing `{…}` in a heading as attributes). `id` matches `msg_` followed by 36 characters from `[0-9a-f-]`; any other shape → `404 not_found` "Route not found". It returns `200 {"id","status","error_code"}`. An unknown id, or another client's id → `404 not_found` "Email not found". A row in `processing` for more than 5 minutes is returned, and stored, as `failed` / `abandoned`. Polling counts against the per-client limit.
- **`## POST /v1/notifications`** has the body `{event, recipient: {email, locale?}, data}`.
  - `event`: at most 64 characters, `^[a-z0-9_]+(\.[a-z0-9_]+)+$`.
  - `recipient.email` and `recipient.locale` follow the same rules as `to` and `locale`.
  - `data` follows the same rules as `variables`.
  - Resolution: the client's mapping, otherwise the built-in. If neither exists → `404 event_not_found`. After that it behaves exactly like `/v1/email/send`, sharing the same Idempotency-Keys and recipient limit.
  - Replay caveat: the event is resolved before the replay lookup. A deleted or remapped event can answer `404` or `400` on a retry, and nothing is ever sent twice.
  - **Move the "Built-in events" table** from `web-app-integration-events.md` here, verbatim, with its closing sentence.

**`api-reference-config.md` — Events, templates and health**

- **`## GET /v1/events`** → `200 [{event, template, updated_at, builtin}]`: the client's own mappings sorted by `event` (`builtin: false`), then the built-ins it has not overridden (`builtin: true`, `updated_at: null`).
- **`## GET /v1/events/:event`** → `200 {event, template, builtin}`. An invalid name → `400`, none found → `404 event_not_found`.
- **`## PUT /v1/events/:event`** has the body `{template}` (`^[a-z0-9-]{1,64}$`). The template must exist in some locale, as the client's own or a built-in, otherwise `404 template_not_found`. Upsert → `200 {event, template, builtin:false}`.
- **`## DELETE /v1/events/:event`** → `204`. With no own mapping → `404 event_not_found`. Built-ins can't be deleted. Deleting an override restores the built-in.
- **`## GET /v1/templates`** → `200 [{name, locale, updated_at, builtin}]`, own templates first (sorted by name and locale), then the built-ins that are not overridden.
- **`## GET /v1/templates/:name/:locale`** → `200 {name, locale, subject, html, text, variables, builtin}`. No `en` fallback here. Bad name or locale → `400`, missing → `404 template_not_found`.
- **`## PUT /v1/templates/:name/:locale`** creates or replaces the template; it overrides a built-in for this client only. Body fields:
  - `subject`: 1–255 characters on one line;
  - `html`: at most 100 KB;
  - `text`: at most 50 KB;
  - `variables`: an array of `^[a-zA-Z0-9_]{1,64}$` names, duplicates removed.

  Every `{{placeholder}}` must be declared, otherwise `400` "undeclared placeholders: …". Values are HTML-escaped in `html`; line breaks are stripped in `subject`. It returns `200` with the stored template and `builtin:false`.
- **`## DELETE /v1/templates/:name/:locale`** → `204`. With no own template → `404 template_not_found`.
- **`## GET /health`** → `200 {"status":"ok"}`, with no key and no rate limit.

## Task 3 steps

- [ ] **Step 1: Write `docs/api-reference.md`** from the facts in Part 2.
- [ ] **Step 2: Write `docs/api-reference-email.md`** from the facts above. Each endpoint gets a `curl` example, built like the one in `web-app-integration.md` "Sending an email".
- [ ] **Step 3: Write `docs/api-reference-config.md`** the same way.
- [ ] **Step 4: Wire it up.**
  - In `config.mts`, add `{ text: "API Reference", link: "/api-reference", activeMatch: "^/api-reference" }` to `nav`.
  - Add a second sidebar group, `{ text: "API Reference", items: [Overview → /api-reference, Sending → /api-reference-email, Events and templates → /api-reference-config] }`.
  - Change the "Next" sentence of `getting-started.md` to: "Wire your app to it with the [integration guide](web-app-integration.md), or look up an endpoint in the [API Reference](api-reference.md)."
- [ ] **Step 5: Verify.** Run `npm run docs:build` (expected: it passes), then compare the error codes with the code (expected: no `diff` output):

```bash
diff <( { grep -rh -A2 "HttpError(" src | grep -oE '"[a-z_]{4,}"'; echo '"internal_error"'; } | tr -d '"' | sort -u ) \
     <( grep -oE '^\| [0-9]{3} \| `[a-z_]+`' docs/api-reference.md | grep -oE '[a-z_]{4,}' | sort -u )
```

  If the left side picks up a non-code string, read it and drop it with `grep -v`; don't drop a real code. Then confirm the anchors: `grep -c 'id="post-v1-email-send"' docs/.vitepress/dist/api-reference-email.html` ≥1, and the same check for `errors`, `delivery-statuses`, `rate-limits` and `idempotency` in `api-reference.html`. Finally run `wc -l docs/api-reference*.md`: each file must be under 200 lines.
- [ ] **Step 6: Commit** with `feat(docs): API Reference`.

### Task 4: Deduplicate the contract

**Files:** `README.md` (the "API" section), `docs/web-app-integration.md`, `-async.md`, `-events.md`, `docs/ai-integration-prompt.md`
**Interfaces:** Consumes the anchors produced by Task 3.

- [ ] **Step 1: README.** Replace everything from `## API` up to `## SMTP configuration` with:
  - one sentence on the API key;
  - the existing `POST /v1/email/send` http block and its JSON response;
  - this sentence: "The **[API Reference](docs/api-reference.md)** documents every endpoint, field rule, error code and status: [sending](docs/api-reference-email.md), and [events, templates and health](docs/api-reference-config.md)."
- [ ] **Step 2: `web-app-integration.md` "Sending an email".** Replace the fields table, the error table and the "Errors always have the shape" line with: "Field rules and every error code: [API Reference](api-reference-email.md#post-v1-email-send). What to retry: [Errors, retries and idempotency](web-app-integration-flows.md#errors-retries-and-idempotency)." Keep the `curl` example, the `submitted` sentence and the closing links.
- [ ] **Step 3: `-async.md`.**
  - In "Reading the outcome", replace the two tables (moved in Task 3) with a link to `api-reference.md#delivery-statuses`.
  - Replace the "New errors" table with one sentence: async adds `413 payload_too_large` (variables over 120 KB) and `503 queue_unavailable` (retry later with the same `Idempotency-Key`), see [Errors](api-reference.md#errors).
- [ ] **Step 4: `-events.md`.**
  - Replace the fields table with a link to `api-reference-email.md#post-v1-notifications`.
  - Replace "Built-in events" (moved in Task 3) with one sentence and the same link.
  - Replace the methods table in "Managing mappings" with a link to `api-reference-config.md`.
  - Replace the "Errors" table with a link to `api-reference.md#errors`.

  Keep the `curl` examples and the explanatory bullets.
- [ ] **Step 5: AI prompt note, then checks.**
  - Under the `# AI integration prompt` title of `ai-integration-prompt.md`, add `<!-- Maintainers: the "API contract" below copies docs/api-reference*.md on purpose (the prompt must be self-contained); update both together. -->`.
  - Run `npm run docs:build` (expected: it passes).
  - Check the README links. Expected: no output.

```bash
grep -oE '\]\(docs/[^)#]+' README.md | cut -c3- | sort -u | while read f; do test -f "$f" || echo "MISSING $f"; done
```

- [ ] **Step 6: Commit** with `docs: API Reference is the single source of the contract`.

### Task 5: Side updates and final verification

**Files:** `README.md`, `CLAUDE.md`

- [ ] **Step 1: README "Docs site" section,** placed before "Roadmap". It covers:
  - the commands `npm run docs:dev`, `docs:build` and `docs:preview`;
  - the Cloudflare Pages settings: project `notify-flow-docs`, production branch `main`, build command `npm run docs:build`, output `docs/.vitepress/dist`, env `NODE_VERSION=22`.

  In "Project structure", change the `docs/` comment to `# docs site (VitePress): guides, API Reference; specs and plans are not published`.
- [ ] **Step 2: `CLAUDE.md`.**
  - Under Commands, add `- npm run docs:dev / docs:build / docs:preview — VitePress site from docs/ (build fails on dead links)`.
  - Under Docs, add `- Site: docs/index.md, docs/getting-started.md (README regions); API contract: docs/api-reference*.md (the AI prompt keeps a copy, update both)`.
- [ ] **Step 3: Final checks.** Run `npm test`, `npm run typecheck` and `npm run docs:build`: all pass. Then check line counts with this command; expected: no output.

```bash
git ls-files '*.md' | xargs wc -l | awk '$2 != "total" && $1 >= 200'
```

- [ ] **Step 4: Visual check** with `npm run docs:preview`:
  - the Home hero and both regions;
  - the sidebar on Documentation and API Reference pages;
  - search finds `idempotency` and `notifications`;
  - dark mode;
  - the `> [!NOTE]` and `> [!WARNING]` blocks render as callouts on Getting started.
- [ ] **Step 5: Commit** with `docs: docs site setup in README and CLAUDE.md`.

Connecting Cloudflare Pages in the dashboard is left to the user: it is outward-facing and needs their account.

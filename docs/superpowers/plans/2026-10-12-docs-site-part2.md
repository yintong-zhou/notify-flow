# Docs Site Plan — Part 2: Home and API Reference

[← Part 1](2026-10-12-docs-site.md) · [Part 3 →](2026-10-12-docs-site-part3.md)

### Task 2: Home page

**Files:** create `docs/index.md`
**Interfaces:** Consumes the README regions `why` and `how-it-works` (Task 1). It produces nothing that other tasks depend on.

- [ ] **Step 1: Write `docs/index.md`.** The `/api-reference` hero link is a frontmatter link, so the dead-link check skips it. It resolves after Task 3.

````md
---
layout: home
hero:
  name: notify-flow
  tagline: Self-hosted transactional email for Cloudflare Workers, over plain SMTP
  actions:
    - { theme: brand, text: Get started, link: /getting-started }
    - { theme: alt, text: API Reference, link: /api-reference }
    - { theme: alt, text: GitHub, link: https://github.com/yintong-zhou/notify-flow }
---

## Why notify-flow

<!--@include: ../README.md#why-->

## How it works

<!--@include: ../README.md#how-it-works-->

## Send your first email

```bash
curl -X POST "$NOTIFY_FLOW_URL/v1/email/send" \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: welcome:user-123" \
  -d '{ "template": "welcome", "to": "jane.doe@example.com",
        "variables": { "appName": "Acme", "name": "Jane" } }'
```

The response is `{"id":"msg_…","status":"submitted"}`: the SMTP server accepted the message.
````

- [ ] **Step 2: Build.** Run `npm run docs:build`. Expected: it passes.
- [ ] **Step 3: Check the regions and the styling.** Run `grep -c "Templates, not raw HTML" docs/.vitepress/dist/index.html` and `grep -c "owns auth logic" docs/.vitepress/dist/index.html`. Expected: ≥1 each. Then open `npm run docs:preview`. Expected: the content below the hero is styled like a doc page (headings, lists, code block). If it renders unstyled, add `<div class="vp-doc">` … `</div>` around the content below the frontmatter, with blank lines inside the div.
- [ ] **Step 4: Commit** with `feat(docs): home page`.

### Task 3: API Reference

**Files:** create `docs/api-reference.md`, `docs/api-reference-email.md` and `docs/api-reference-config.md`. Modify `docs/.vitepress/config.mts` (nav and sidebar) and `docs/getting-started.md` (the "Next" link).

**Interfaces:**
- Consumes: `themeConfig.nav` and `sidebar` from Task 1.
- Produces: the anchors Task 4 links to. They are VitePress slugs of these exact headings:
  - in `api-reference.md`: `## Errors` → `#errors`, `## Delivery statuses` → `#delivery-statuses`, `## Rate limits` → `#rate-limits`, `## Idempotency` → `#idempotency`;
  - in `api-reference-email.md`: `## POST /v1/email/send` → `#post-v1-email-send`, `## POST /v1/notifications` → `#post-v1-notifications`.

  Check each slug in the built HTML (`grep 'id="post-v1-email-send"'`) before Task 4 uses it.

Write from the facts below, every one checked against `src/` on 2026-10-12. Each endpoint uses this fixed shape: purpose (one line), headers, body fields table, responses with JSON examples, specific errors, and a `curl` example. Keep each file under 200 lines; tables beat prose.

**`api-reference.md` — Overview**

- **Base URL:** the Worker's URL, for example `https://notify-flow.<account>.workers.dev`. There is no global prefix: the API lives under `/v1/`.
- **Authentication:** every `/v1/*` route requires `Authorization: Bearer <key>` or `X-API-Key: <key>`. If the `Authorization` header starts with `Bearer `, it wins. No key → `401` "Missing API key". Unknown key, or key over 128 characters → `401` "Invalid API key". `/health` needs no key.
- **Order of checks on `/v1/*`:**
  1. IP limit
  2. API key
  3. client limit
  4. route and method
  5. `Idempotency-Key`
  6. body

  So a wrong method without a key gets `401`, not `405`. Paths outside `/v1/` other than `/health` get `404 not_found` without any check.
- **Body:** JSON object, at most 256 KB.
  - Larger → `413 payload_too_large`.
  - Not JSON → `400 invalid_json`.
  - Not an object → `400 validation_error`.
- **Idempotency** (`## Idempotency`):
  - `Idempotency-Key` is 1–255 characters, validated before the body. Its scope is the client, and it is shared by `/v1/email/send` and `/v1/notifications`.
  - A replay returns the stored `{id, status}` without sending (`200`, or `202` when async), even when `status` is `failed`. It is answered before the recipient limit.
  - A replay of a row that has stayed `processing` for more than 5 minutes closes it as `failed` (`abandoned`).
  - No key: every call sends.
- **Async:** `Prefer: respond-async`. The match is case-insensitive and the header may list other preferences.
  - Success: `202 {"id","status":"queued"}` with `Preference-Applied: respond-async`.
  - Variables over 120 KB → `413 payload_too_large`.
  - Queue down → `503 queue_unavailable`, carrying `id`.
  - Up to 5 attempts, after 1, 5, 15 and 30 minutes.
- **Rate limits** (`## Rate limits`):
  - 300 requests / 60 s per IP;
  - 60 / 60 s per client, all `/v1/*` routes;
  - `RECIPIENT_LIMIT_PER_HOUR` (default 5) emails per client + recipient + template per hour, with failed sends excluded.

  All three answer `429 rate_limited`.
- **Error shape:** `{"error":{"code":"…","message":"…"}}`. A `502` or `503` also carries the delivery id at the top level: `{"error":{…},"id":"msg_…"}`.
- **`## Errors`:** the 14 codes, with status and when each happens:

| Status | Code | When |
|---|---|---|
| 400 | `invalid_json` | Body is not valid JSON |
| 400 | `validation_error` | A field, a path parameter or `Idempotency-Key` breaks its rule |
| 400 | `invalid_variables` | Variables don't match the template's list. The message lists `missing` and `unexpected` |
| 401 | `unauthorized` | Missing or invalid API key |
| 404 | `not_found` | Unknown route, or unknown / other client's email id |
| 404 | `template_not_found` | Template missing in the locale and in `en`; on `PUT /v1/events`, missing in every locale |
| 404 | `event_not_found` | No mapping and no built-in for the event |
| 405 | `method_not_allowed` | The message lists the allowed methods |
| 413 | `payload_too_large` | Body over 256 KB, or async variables over 120 KB |
| 429 | `rate_limited` | Any of the three limits |
| 500 | `smtp_misconfigured` | SMTP vars/secrets missing or invalid |
| 500 | `internal_error` | Unexpected error |
| 502 | `smtp_failed` | SMTP refused the message after 3 attempts (0.5 s, 1 s backoff), or never confirmed it. Carries `id` |
| 503 | `queue_unavailable` | Async only. Carries `id`; retry with the same key |

- **`## Delivery statuses`:** move the two tables (`status` and `error_code`) from "Reading the outcome" in `web-app-integration-async.md` here, verbatim; Task 4 replaces them in the guide with a link. Make two additions:
  - an `internal_error` row in the `error_code` table: an unexpected error during the send;
  - one line saying `accepted` is in the schema but no code path writes it today, so it is reserved.

The endpoint pages are in [Part 3](2026-10-12-docs-site-part3.md#task-3-continued-endpoint-pages).

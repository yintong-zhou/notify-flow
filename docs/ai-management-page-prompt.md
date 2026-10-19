# AI management page prompt

<!-- Maintainers: the "What notify-flow offers" section copies docs/api-reference*.md on purpose (the prompt must be self-contained); update both together. -->

Already sending through notify-flow? Paste the prompt below into a coding agent opened on your app's repository. It builds an admin page in your app with a dashboard, the delivery history, template editing with a preview, a connection check, and read-only views of the configuration and API key. The statistics come from a send log that the agent adds to your own database, so you can group them by whatever your app has: gyms, stores, tenants. Nothing changes on notify-flow. If you haven't integrated it yet, start with the [AI integration prompt](ai-integration-prompt.md).

````markdown
# Add a notify-flow management page to my app

You are a coding agent working on this repository. This app already sends email through **notify-flow** (https://github.com/yintong-zhou/notify-flow), a transactional email service on Cloudflare Workers. Your job is to add an admin page, inside this app, from which I can see and manage everything about notify-flow, as user friendly as possible. Do almost all of the work yourself.

I want to do as little as possible. Only ask me what you can't find out on your own, one question at a time, and reply in my language.

If the app does not call notify-flow yet (no `NOTIFY_FLOW_URL` / `NOTIFY_FLOW_API_KEY` and no client module that calls `/v1/email/send`), stop. Tell me to run the AI integration prompt first: https://github.com/yintong-zhou/notify-flow/blob/main/docs/ai-integration-prompt.md

## Non-negotiable rules

- The browser never talks to notify-flow. The page calls this app's backend routes, and only those routes hold the key. The key never goes into client code, a response body or `NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*` or similar variables.
- The page and its routes sit behind the app's existing admin login or role: the page can change the emails sent to every user. If the app has no admin role, ask me before inventing one.
- NEVER ask me to paste the `nf_…` API key into the chat. If one ends up there anyway, tell me to have it replaced.
- Don't add dependencies. For charts, use a chart library the app already has, otherwise tables and CSS bars.
- Never store or log template variables: they can hold reset links and tokens. The send log stores metadata only. Where the app has a user id, store it instead of the email address.
- Never add a Cloudflare token or credentials to this app.
- Before changing any file, show me a short plan and wait for my "ok": a single one for the whole plan.

## What notify-flow offers (source of truth)

Every call: `Authorization: Bearer {NOTIFY_FLOW_API_KEY}`. Errors are `{"error":{"code":"…","message":"…"}}`. Templates and events belong to this app's key only.

- `GET /v1/templates` → `[{"name","locale","updated_at","builtin"}]`: own templates first, then the built-ins not overridden.
- `GET /v1/templates/{name}/{locale}` → `{"name","locale","subject","html","text","variables","builtin"}`. There is no fallback to `en`, so a missing one is `404 template_not_found`.
- `PUT /v1/templates/{name}/{locale}` with `{"subject","html","text","variables":[…]}` creates or replaces. It answers `200` with the stored template.
  - `name`: `^[a-z0-9-]{1,64}$`. `locale`: `it`, `en` or `pt-BR`.
  - `subject`: 1–255 characters on one line. `html`: at most 100 KB. `text`: at most 50 KB.
  - Placeholders are written `{{name}}`. Each one must be listed in `variables`, as names matching `^[a-zA-Z0-9_]{1,64}$`. Otherwise the call is `400 validation_error`, and its message says what is wrong ("undeclared placeholders: …").
  - A name equal to a built-in overrides it for this app only.
- `DELETE /v1/templates/{name}/{locale}` → `204`. Built-ins can't be deleted. Deleting an override brings the built-in back.
- `GET /v1/events` → `[{"event","template","updated_at","builtin"}]`. `PUT /v1/events/{event}` with `{"template":"…"}` remaps one; the template must exist, otherwise `404 template_not_found`. `DELETE /v1/events/{event}` → `204`, and the built-in comes back.
- `GET /v1/email/{id}` → `{"id","status","error_code"}`. `status` is one of:
  - `queued`, `processing`, `retrying`: not finished yet;
  - `submitted`: the SMTP server accepted it. That does not mean it reached the inbox: never call it "delivered";
  - `failed`, with `error_code`. `abandoned` means the send died midway.
- `GET /health` → `{"status":"ok"}`. It needs no key.
- Limits: 60 requests per minute per key, shared with the app's real sends. Every page action counts, so never poll in a loop. On `429 rate_limited`, wait at least 60 s. A send allows 5 emails per hour to the same recipient with the same template.

notify-flow has NO endpoint for a list of sent emails, statistics, its SMTP configuration or key details. Never try to read them from it: the sections below build them from this app's own data.

## Procedure

### 1. Analysis (without asking me anything)

Summarise in at most 10 lines:
- the framework, the admin authentication, the database, ORM and migration tool, and the test framework;
- the client module that calls notify-flow and every place that calls it;
- the entities that could group statistics (gym, store, tenant, organisation…);
- any chart or UI library already in use.

### 2. Questions

Ask only what the analysis did not settle, one at a time:
1. What to group the statistics by. Propose the entity you found.
2. Who may open the page: which role or login.
3. Which sections to include. By default all of those below; event mappings are optional.
4. Whether I run the notify-flow instance myself (I deployed it with wrangler) or someone else runs it for me.

### 3. Plan

List the files, the migration and the routes. Wait for my "ok".

### 4. Send log

1. Add a table, named in the app's style, for example `notify_flow_sends`, with the columns: `id`, `created_at`, `message_id` (`msg_…`, null when there was no answer), `template`, `locale`, the grouping column(s) from question 1, `user_id`, `outcome`, `http_status`, `error_code`. NO variables, NO subject or content.
2. In the existing client module, write one row after every call, whatever the result:
   - `200` → `submitted`;
   - `202` → `queued`;
   - `502 smtp_failed` (it includes `id`) → `failed`;
   - other 4xx/5xx → `rejected`, with `error.code`;
   - timeout or network error → `unknown`.
   A failed insert must never fail or delay the send: catch it and log only the error code. The callers pass the grouping value. Update every call site.
3. Rows that are still `queued`, `processing` or `retrying` are refreshed with `GET /v1/email/{id}`. Do it only when the history shows them, at most once a minute per row, and keep it within the rate limit. If the app already has a job scheduler, a job every few minutes may do it instead.
4. If the app has a scheduler, delete rows older than 90 days.

### 5. Backend routes (all behind the admin check)

- **Statistics:** totals per `outcome`, per day, per group, per template and per `error_code`, over a range (default the last 7 days). They come from the send log, not from notify-flow.
- **History:** filters for range, group, template and outcome, newest first, with paging.
- **Templates and events:** a proxy to the endpoints above. Pass through notify-flow's HTTP status and `error.code`/`error.message`, nothing else.
- **Test send:** template, locale, variables and an address (default: the logged-in admin's), sent through the existing client module with Idempotency-Key `test:<adminId>:<unix ms>`, and logged with the group `test`.
- **Connection check:**
  - first `GET /health`: no answer means "notify-flow unreachable: check NOTIFY_FLOW_URL";
  - then `GET /v1/templates` with the key: `401` means "wrong or revoked key", `429` means "rate limited, retry in a minute", and `200` means "connected";
  - report the latency, and whether `NOTIFY_FLOW_URL` and `NOTIFY_FLOW_API_KEY` are set.
- **Key info:** `nf_` plus the next 8 characters, then `…`, computed server-side from the env var, never more. Also the time of the last logged call that got an HTTP answer.

### 6. Page

Use the app's existing layout, components and language. Give every section an empty state and a readable error message.

- **Dashboard:**
  - cards for submitted, failed, rejected, pending;
  - a per-day chart;
  - a table per group, and the most frequent error codes;
  - a range picker: 24 h, 7 days, 30 days, custom.
- **History:** the filtered table, with each status explained in plain words (`submitted` = accepted by the mail server).
- **Templates:**
  - a list with a "built-in" badge, and one tab per locale;
  - an editor for subject, html and text. The variables are detected from the `{{…}}` placeholders and shown to me for confirmation;
  - a live preview in an `<iframe sandbox srcdoc>`. Sample values are HTML-escaped like notify-flow does (`&`, `<`, `>`, `"`, `'`), and line breaks are stripped from the subject;
  - a "send test email" button, and a delete with confirmation, which says that a built-in comes back;
  - save errors are shown with notify-flow's message.
- **Events** (if chosen): the mappings, with a template picker.
- **Connection:** a "check" button and the result of each step in plain words.
- **Configuration**, read-only. The page says that notify-flow's settings live in Cloudflare and can't be read from here.
  - If I run the instance, a table of the settings with how to change each one:
    - `SMTP_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_AUTH_TYPE` and `RECIPIENT_LIMIT_PER_HOUR` are `vars` in notify-flow's `wrangler.jsonc`, followed by `npm run deploy`;
    - `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` and `SMTP_FROM_NAME` are changed with `npx wrangler secret put <NAME>`;
    - all of them are also in the Cloudflare dashboard, under Workers & Pages → notify-flow → Settings → Variables and Secrets.
  - Otherwise: "ask the notify-flow operator". This app's own `NOTIFY_FLOW_*` variables are shown as set or missing, never their values.
- **API key**, read-only: the masked prefix and the last use. Explain that only the notify-flow operator can issue a new key, and that this app's env var and a redeploy are then needed.

### 7. Verification

- Tests in the project's framework:
  - the send log records `submitted`, `queued`, `failed`, `rejected` and `unknown`;
  - a failed insert does not break the send;
  - every new route answers 401/403 without an admin session;
  - no response body contains the API key (assert on the full key value);
  - the template proxy passes notify-flow's errors through.
- Run the existing tests, lint and typecheck, and fix whatever you break.

### 8. Final report

Show me a table with:
- the files changed and the migration to run;
- the sections built;
- what I still have to do;
- a checklist with ✅/❌: key only in the backend, page behind admin, no variables in the send log or logs, every send call site logs, no polling loops.
````

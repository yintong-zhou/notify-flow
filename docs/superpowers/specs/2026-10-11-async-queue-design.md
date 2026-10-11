# Asynchronous Sending with Cloudflare Queues — Design

Date: 2026-10-11
Builds on: [MVP design](2026-10-08-notification-service-mvp-design.md) ([part 2](2026-10-08-notification-service-mvp-design-part2.md))
Source requirements: [`docs/requirements/statuses-queues-structure.md`](../../requirements/statuses-queues-structure.md)

## Goal

Two outcomes:
- **Fast response:** a caller that opts in gets `202 Accepted` without waiting for the SMTP session.
- **SMTP resilience:** an email survives an SMTP outage of minutes, because the queue retries it over about 50 minutes instead of answering `502`.

Success: `POST /v1/email/send` with `Prefer: respond-async` returns `202 {"id","status":"queued"}`. The email is later sent by a queue consumer, and the caller reads the outcome with `GET /v1/email/:id`. The same email is never sent twice, and every existing constraint still holds: idempotency, the atomic recipient limit, and no content in D1 or logs.

## Decisions

- **Opt-in per request:** asynchronous sending is requested with `Prefer: respond-async` (RFC 7240). Without the header, the synchronous path is unchanged.
- **One Worker:** the existing Worker is both producer and consumer (`fetch`, `scheduled` and `queue` handlers). A separate Email Worker would add a second deploy, duplicated secrets and shared code for no benefit with a single service.
- **Outcome by polling:** `GET /v1/email/:id`. No webhooks.
- **5 SMTP attempts** in total per queued email.
- **No dead letter queue:** the daily cron closes stuck rows instead.

Rejected: `202` with `ctx.waitUntil` and no queue. It is fast, but a failed send has no durable retry.

## Producer: the async request

`POST /v1/email/send` with `Prefer: respond-async`:

1. **Same checks as the sync path:** auth, rate limits, validation, `resolveSmtpConfig` (a broken SMTP configuration fails fast with `500 smtp_misconfigured`), `resolveTemplate` and `checkVariables`.
2. **Idempotency:** a replay of an `Idempotency-Key` returns the row's current status.
3. **Atomic `INSERT`** with the recipient limit, as today, but with status `queued`. `queued` rows count against the limit, which excludes only `failed`.
4. **`env.EMAIL_QUEUE.send(message)`.** If enqueueing throws, the row becomes `failed` with `error_code = 'enqueue_failed'` (so it does not count against the limit) and the response is `503 queue_unavailable`. The `INSERT` comes first so the limit stays atomic and no message exists without a row.
5. **Response:** `202 {"id":"msg_…","status":"queued"}` with `Preference-Applied: respond-async`. An async replay always answers `202` with the current status, even `submitted` or `failed`.

Steps 1–3 move from `sendTemplatedEmail` into a shared `reserveDelivery(env, clientId, request, options, status)`. It returns either an existing result (a replay) or the new row id with the resolved template and config. The sync path then sends as today; the async path enqueues.

**Queue message:** `{id, clientId, to, template, locale, variables}`.
- **Not pre-rendered:** a queue message is capped at 128 KB, and a template allows 100 KB of HTML plus 50 KB of text.
- **Size limit:** if the serialized message exceeds 128 KB, the request fails with `413 payload_too_large` before the `INSERT`.
- **Sensitive data:** `variables` (tokens, reset URLs) pass through the queue. Cloudflare encrypts messages at rest and deletes them on `ack`, and they never reach D1 or logs. The queue is still a new place where this data lives for up to about an hour, and it is documented as such.

## Consumer

`queue(batch, env)` in `src/index.ts` calls `handleQueue(batch, env, send)` (dependency injection, like `handle`). Messages in a batch are processed one at a time, and each is acked or retried on its own.

Queues deliver **at least once**, so the consumer must tolerate duplicates. For each message:

1. **Claim:** `UPDATE email_deliveries SET status = 'processing', attempts = attempts + 1, claimed_at = unixepoch() WHERE id = ? AND status IN ('queued', 'retrying') RETURNING attempts`.
   - **0 rows changed:** the row is `submitted`, `failed`, or `processing` (another delivery is running or died mid-send). The consumer calls `ack()` and sends nothing. This claim is the double-send guard.
2. **Render:** resolve the template again and render it. A template changed since the request is sent in its new version.
3. **One SMTP attempt** per delivery. The sync path's in-request retry loop is not used: the queue spaces the retries out.
4. **Outcome:**

| Outcome | D1 row | Queue |
|---|---|---|
| Sent | `submitted`, `sent_at` | `ack` |
| Transient `SmtpError`, attempts < 5 | `retrying`, `error_code` | `retry({ delaySeconds })` |
| Permanent error, `smtp_unconfirmed`, or 5th attempt failed | `failed`, `error_code` | `ack` |
| Template deleted, or variables no longer match | `failed`, the renderer's `HttpError` code (`template_not_found` / `invalid_variables`) | `ack` |
| Unexpected error after the claim | `failed`, `internal_error` | `ack` |
| Unexpected error before the claim (e.g. D1 down) | unchanged | `retry` |

- **Delays:** `delaySeconds` after attempt 1, 2, 3 and 4 is 60, 300, 900 and 1800: about 50 minutes in total.
- **Logs:** a final failure logs `console.error({id, client_id, error_code})`, as today.
- **Success not recorded:** if the `submitted` `UPDATE` fails after a successful send, the message is still acked. The email is out and must never be retried. The row stays `processing` and is later closed as `abandoned`, the same ceiling as the sync path.

**Consumer config** (`wrangler.jsonc` and the example):

```jsonc
"queues": {
  "producers": [{ "binding": "EMAIL_QUEUE", "queue": "notify-flow-emails" }],
  "consumers": [{
    "queue": "notify-flow-emails",
    "max_batch_size": 10,      // keeps one batch to a few SMTP sessions
    "max_batch_timeout": 5,
    "max_retries": 5,          // >= the 4 app retries, so the queue never drops a message first
    "max_concurrency": 2       // few parallel SMTP sessions on the provider
  }]
}
```

The queue is created once before deploying: `npx wrangler queues create notify-flow-emails`. Queues are also available on the Workers Free plan, which keeps messages for 24 hours; the retry window fits well inside that.

## Stuck rows

- **`processing` for more than 5 minutes:** the Worker died mid-send. The existing replay logic closes the row as `failed / abandoned`; `GET /v1/email/:id` applies the same rule. "Maybe not sent" is preferred over "sent twice".
  - The 5 minutes count from `COALESCE(claimed_at, created_at)`. A queued row can be claimed long after it was created, so `created_at` alone would close a send that is still running. The sync path leaves `claimed_at` NULL, which keeps its behavior unchanged.
- **`queued` or `retrying` for more than 24 hours:** the queue dropped the message after `max_retries` unexpected errors. The daily cron runs one extra `UPDATE` that closes these rows as `failed / abandoned`, before purging old rows.

## API: `GET /v1/email/:id`

- **Response:** `200 {"id","status","error_code"}`. No recipient, template or variables.
- **Isolation:** the row must belong to the authenticated client. Another client's id, a malformed id and an unknown id all return `404 not_found`, so existence never leaks.
- **Limits:** it is a `/v1/*` route, so the IP and per-client rate limits apply.
- **Abandoned rows:** a `processing` row older than 5 minutes is closed and reported as `failed`.

**Migration `0004_deliveries_claimed_at.sql`:** `ALTER TABLE email_deliveries ADD COLUMN claimed_at INTEGER;` (unix seconds of the consumer's claim). The `status` CHECK already allows `queued` and `retrying`.

## Testing

Dependency injection only (`vi.mock` does not work in the Workers pool).

- **Producer:** a fake `EMAIL_QUEUE` in the test `env` records messages and can be set to throw.
  - `202`, a `queued` row, and a message holding no rendered content;
  - an async replay answers `202` with the current status;
  - an enqueue failure answers `503`, and the row is `failed / enqueue_failed`;
  - `queued` rows count against the recipient limit;
  - an oversized message answers `413` with no row;
  - without `Prefer`, the sync path is unchanged (existing tests).
- **Consumer:** `handleQueue` with a fake batch that records `ack` and `retry(options)`.
  - success: `submitted` and acked;
  - a duplicate delivery of a claimed or finished row: acked, nothing sent;
  - a transient error: `retrying`, retried with the right delay;
  - the 5th transient failure: `failed`, acked;
  - a permanent error and `smtp_unconfirmed`: `failed`, no retry;
  - a deleted template: `failed / template_not_found`;
  - D1 failing before the claim: retried, nothing sent.
- **`GET /v1/email/:id`:** own row, another client's row, unknown id, abandoned `processing` row, and an old row claimed just now (not abandoned).
- **Cron:** closes `queued` and `retrying` rows older than 24 hours and keeps recent ones.

## Documentation

- **Integration guide:** a new linked part, `docs/web-app-integration-async.md`, on `Prefer: respond-async`, `202`, and polling `GET /v1/email/:id`. The main guide is at 184 lines, so it gets only a link.
- **README and CLAUDE.md:** drop Queues from the roadmap and "Not in the MVP", and update the request flow and the status list.
- Every Markdown file stays under 200 lines.

# Async Sending with Cloudflare Queues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /v1/email/send` with `Prefer: respond-async` answers `202 queued`. The same Worker consumes the queue and sends with up to 5 SMTP attempts, and callers read the outcome with `GET /v1/email/:id`.

**Architecture:** The sync path's checks and atomic `INSERT` move into a shared `reserveDelivery`. The async path then enqueues `{id, clientId, template, to, locale, variables}` instead of sending. A `queue()` handler claims each row atomically (the double-send guard), renders it, sends once, and acks or schedules a delayed retry.

**Tech Stack:** TypeScript on Cloudflare Workers, D1, Cloudflare Queues, and vitest in workerd via `@cloudflare/vitest-plugin`. No runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-10-11-async-queue-design.md`](../specs/2026-10-11-async-queue-design.md)

**Parts:**
1. This file: constraints, file map, Task 1 steps.
2. [Part 2](2026-10-11-async-queue-part2.md): Task 1 code, Task 2 steps (producer).
3. [Part 3](2026-10-11-async-queue-part3.md): Task 2 tests and code, Task 3 steps (consumer).
4. [Part 4](2026-10-11-async-queue-part4.md): Task 3 tests.
5. [Part 5](2026-10-11-async-queue-part5.md): Task 3 code, Task 4 (GET).
6. [Part 6](2026-10-11-async-queue-part6.md): Task 5 (cron), Task 6 (docs).

## Global Constraints

- **No runtime dependencies.** Do not add packages.
- **`vi.mock` does not work in the Workers pool.** Inject dependencies: a fake queue through `env`, `send` as a parameter, and a fake `MessageBatch`.
- **No sensitive data at rest.** `email_deliveries` and `console.error` must never contain variables, rendered content, tokens or URLs. `console.error` logs only `{id, client_id, error_code}`.
- **Never send the same email twice.** A redelivered queue message must not send again.
- **Statuses:** `queued`, `processing`, `retrying`, `submitted` and `failed`. Never `delivered`.
- **Sync path unchanged:** without `Prefer: respond-async`, every existing test passes unmodified.
- **Exact queue values:**
  - queue name `notify-flow-emails`, binding `EMAIL_QUEUE`;
  - `max_batch_size: 10`, `max_batch_timeout: 5`, `max_retries: 5`, `max_concurrency: 2`;
  - 5 SMTP attempts in total, with delays of 60, 300, 900 and 1800 seconds;
  - stuck `queued` or `retrying` rows are closed after 24 hours.
- **`wrangler.jsonc` is git-ignored.** Edit both it and `wrangler.jsonc.example`, and commit only the example.
- **Markdown under 200 lines.** Every `.md` file stays under 200 lines.
- **Commands:**
  - `npx vitest run <file>` and `npx vitest run -t "<name>"` for single tests;
  - `npm test` for the full suite;
  - `npm run typecheck`, which regenerates `worker-configuration.d.ts` and then runs `tsc`.

## Review Focus

Inputs the spec implies but its task list did not test. Each has a test in its owning task.

1. **`Prefer` with several preferences or other casing** (`wait=5, Respond-Async`) must still be async. Task 2.
2. **Sync replay of an async `Idempotency-Key`** must answer the stored `queued` result without sending or enqueueing. Task 2.
3. **One failing message in a batch** (D1 error for that message) must not stop the others. Task 3.
4. **An old row claimed just now** must not be closed as abandoned, on replay (Task 1) or on `GET` (Task 4).
5. **Retry, then success:** a `submitted` row must not keep the earlier `error_code` from the retry. Task 3.

## File Map

| File | Change | Responsibility |
|---|---|---|
| `migrations/0004_deliveries_claimed_at.sql` | create | `claimed_at` column |
| `src/services/email-service.ts` | modify | `findDelivery`, `reserveDelivery`, `mailMessage`, `enqueueTemplatedEmail`, `QueuedEmail`, stale-row purge |
| `src/services/queue-consumer.ts` | create | `handleQueue`: claim, render, send, ack or retry |
| `src/routes/email.ts` | modify | async branch on `Prefer`, `getEmail` |
| `src/index.ts` | modify | `GET /v1/email/:id` route, `queue` handler |
| `wrangler.jsonc.example`, `wrangler.jsonc` | modify | queue producer and consumer |
| `test/helpers.ts` | modify | `fakeQueue()` |
| `test/send-api.test.ts` | modify | Task 1 replay test |
| `test/async-send.test.ts` | create | producer, consumer, GET and cron tests |
| `docs/web-app-integration-async.md` | create | caller guide for async |
| `docs/web-app-integration.md`, `README.md`, `CLAUDE.md` | modify | links, roadmap, architecture |

---

### Task 1: Shared delivery helpers and `claimed_at`

A refactor with no behavior change except the abandoned rule, which now counts from `COALESCE(claimed_at, created_at)`.

**Files:**
- Create: `migrations/0004_deliveries_claimed_at.sql`
- Modify: `src/services/email-service.ts`
- Test: `test/send-api.test.ts`

**Interfaces:**
- **Produces:**
  - `interface SendOptions { idempotencyKey: string | null; requestId: string }`
  - `interface Delivery extends SendResult { error_code: string | null }`
  - `findDelivery(db: D1Database, clientId: string, column: "id" | "idempotency_key", value: string): Promise<Delivery | null>`
  - `interface Reservation { id: string; config: SmtpConfig; template: Template }`
  - `reserveDelivery(env: Env, clientId: string, request: SendRequest, options: SendOptions, status: "processing" | "queued"): Promise<SendResult | Reservation>`. A replay returns a `SendResult`; tell the two apart with `"status" in result`.
  - `mailMessage(config: SmtpConfig, id: string, to: string, rendered: Rendered): MailMessage`

- [ ] **Step 1: Write the failing test.** In `test/send-api.test.ts`, add this right after the test `"reports an abandoned processing row as failed on replay"`:

```ts
  it("does not treat an old row claimed just now as abandoned", async () => {
    const { id: clientId, key } = await createClient();
    const to = `claimed-${crypto.randomUUID()}@example.com`;
    await env.DB.prepare(
      `INSERT INTO email_deliveries (id, request_id, client_id, idempotency_key, template, provider, recipient, status, created_at, claimed_at)
       VALUES ('msg_claimed', 'r', ?, 'claimed-key', 'welcome', 'gmail', ?, 'processing', unixepoch() - 3600, unixepoch())`,
    )
      .bind(clientId, to)
      .run();
    const replay = await send(key, welcome(to), recorder().send, { "Idempotency-Key": "claimed-key" });
    expect(await replay.json()).toEqual({ id: "msg_claimed", status: "processing" });
  });
```

- [ ] **Step 2: Run the test.** Command: `npx vitest run -t "claimed just now"`. Expected: FAIL with `no column named claimed_at` or a 500.

- [ ] **Step 3: Write the migration** in `migrations/0004_deliveries_claimed_at.sql`:

```sql
-- When the queue consumer claimed the row; the abandoned rule counts from it (created_at on the sync path).
ALTER TABLE email_deliveries ADD COLUMN claimed_at INTEGER;
```

- [ ] **Step 4: Refactor `src/services/email-service.ts`** using the code in [Part 2, "Task 1 code"](2026-10-11-async-queue-part2.md#task-1-code).

- [ ] **Step 5: Run everything.** Command: `npm test && npm run typecheck`. Expected: all tests pass, including the new one, and `tsc` reports no errors.

- [ ] **Step 6: Commit.**

```bash
git add migrations/0004_deliveries_claimed_at.sql src/services/email-service.ts test/send-api.test.ts
git commit -m "refactor: extract reserveDelivery and count abandoned rows from claimed_at"
```

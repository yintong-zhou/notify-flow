# Async Queue Plan — Part 2: Task 1 code and producer

[← Part 1](2026-10-11-async-queue.md) · [Part 3: consumer →](2026-10-11-async-queue-part3.md)

## Task 1 code

In `src/services/email-service.ts`:
- **Keep unchanged:** `MAX_ATTEMPTS`, `BACKOFF_MS`, `sleep`, `SendResult`, `ABANDONED_AFTER_S`, `RETENTION_S`, `PURGE_BATCH`, `purgeDeliveries`, and the retry `for` loop of `sendTemplatedEmail`.
- **Replace:** the imports, `findByIdempotencyKey`, and the part of `sendTemplatedEmail` before its `for` loop.

```ts
import type { SendRequest } from "../security/validation";
import { resolveSmtpConfig, type SmtpConfig } from "../smtp/provider";
import { SmtpError, type MailMessage, type SendMailFn } from "../smtp/smtp-client";
import { checkVariables, render, resolveTemplate, type Rendered } from "../templates/renderer";
import { HttpError, type DeliveryStatus, type Template } from "../types";

export interface Delivery extends SendResult {
  error_code: string | null;
}

export interface SendOptions {
  idempotencyKey: string | null;
  requestId: string;
}

/**
 * A client's delivery by id or Idempotency-Key. A `processing` row claimed (on the sync path: created) more than
 * ABANDONED_AFTER_S ago is closed as failed.
 */
export async function findDelivery(
  db: D1Database,
  clientId: string,
  column: "id" | "idempotency_key",
  value: string,
): Promise<Delivery | null> {
  const row = await db
    .prepare(
      `SELECT id, status, error_code, COALESCE(claimed_at, created_at) < unixepoch() - ? AS abandoned
       FROM email_deliveries WHERE client_id = ? AND ${column} = ?`,
    )
    .bind(ABANDONED_AFTER_S, clientId, value)
    .first<Delivery & { abandoned: number }>();
  if (!row) return null;
  if (row.status === "processing" && row.abandoned) {
    // The send died midway (e.g. the runtime was cancelled). The email may or may not have gone out.
    await db
      .prepare("UPDATE email_deliveries SET status = 'failed', error_code = 'abandoned' WHERE id = ? AND status = 'processing'")
      .bind(row.id)
      .run();
    return { id: row.id, status: "failed", error_code: "abandoned" };
  }
  return { id: row.id, status: row.status, error_code: row.error_code };
}

/** The answer to a replayed Idempotency-Key: the stored id and status. */
async function findReplay(db: D1Database, clientId: string, key: string | null): Promise<SendResult | null> {
  const found = key === null ? null : await findDelivery(db, clientId, "idempotency_key", key);
  return found && { id: found.id, status: found.status };
}

export interface Reservation {
  id: string;
  config: SmtpConfig;
  template: Template;
}

/** Checks the request and inserts its row with `status`; a replayed Idempotency-Key gets the stored result instead. */
export async function reserveDelivery(
  env: Env,
  clientId: string,
  request: SendRequest,
  options: SendOptions,
  status: "processing" | "queued",
): Promise<SendResult | Reservation> {
  const config = resolveSmtpConfig(env);
  const template = await resolveTemplate(env.DB, clientId, request.template, request.locale);
  checkVariables(template, request.variables);

  // Replays are answered before the recipient limit, so a retrying backend always gets the original result.
  const replay = await findReplay(env.DB, clientId, options.idempotencyKey);
  if (replay) return replay;
  // Count and insert in one statement, so a concurrent burst cannot exceed the limit. Per client (no cross-tenant
  // lockout), and failed sends don't count (an SMTP outage must not lock users out).
  const id = `msg_${crypto.randomUUID()}`;
  const { meta } = await env.DB.prepare(
    `INSERT INTO email_deliveries (id, request_id, client_id, idempotency_key, template, provider, recipient, status, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?9, unixepoch()
     WHERE (SELECT COUNT(*) FROM email_deliveries
            WHERE client_id = ?3 AND recipient = ?7 AND template = ?5 AND status != 'failed' AND created_at > unixepoch() - 3600) < ?8
     ON CONFLICT (client_id, idempotency_key) DO NOTHING`,
  )
    .bind(id, options.requestId, clientId, options.idempotencyKey, request.template, config.provider, request.to,
      Number(env.RECIPIENT_LIMIT_PER_HOUR || 5), status)
    .run();
  if (meta.changes === 0) {
    // Either a concurrent request with the same Idempotency-Key won the insert (NULL keys never conflict), or the
    // recipient limit is reached.
    const existing = await findReplay(env.DB, clientId, options.idempotencyKey);
    if (existing) return existing;
    throw new HttpError(429, "rate_limited", "Too many emails for this recipient and template");
  }
  return { id, config, template };
}

export function mailMessage(config: SmtpConfig, id: string, to: string, rendered: Rendered): MailMessage {
  const domain = config.from.slice(config.from.lastIndexOf("@") + 1);
  return { from: config.from, fromName: config.fromName, to, messageId: `${id}@${domain}`, ...rendered };
}

export async function sendTemplatedEmail(
  env: Env,
  clientId: string,
  request: SendRequest,
  options: SendOptions,
  send: SendMailFn,
): Promise<SendResult> {
  const reserved = await reserveDelivery(env, clientId, request, options, "processing");
  if ("status" in reserved) return reserved;
  const { id, config, template } = reserved;
  const message = mailMessage(config, id, request.to, render(template, request.variables));

  // ... the existing `for (let attempt = 1; ; attempt++)` loop, unchanged ...
}
```

---

### Task 2: Producer (`Prefer: respond-async`, `202 queued`)

**Files:**
- Modify: `wrangler.jsonc.example` and `wrangler.jsonc` (after the `ratelimits` array)
- Modify: `src/services/email-service.ts`, `src/routes/email.ts`, `test/helpers.ts`
- Create: `test/async-send.test.ts`

**Interfaces:**
- **Consumes:** `reserveDelivery` and `SendOptions` from Task 1.
- **Produces:**
  - `interface QueuedEmail extends SendRequest { id: string; clientId: string }`
  - `enqueueTemplatedEmail(env: Env, clientId: string, request: SendRequest, options: SendOptions): Promise<SendResult>`
  - `fakeQueue(fail?: boolean): { queue: Queue; sent: any[] }` in `test/helpers.ts`
  - Test helpers in `test/async-send.test.ts`: `welcome`, `unique`, `row`, `sendAsync`.

- [ ] **Step 1: Config.** Add this to both wrangler files, then run `npm run typecheck` so that `Env` gains `EMAIL_QUEUE`:

```jsonc
  // Async sending (Prefer: respond-async): the API enqueues, this same Worker consumes and sends.
  // Create the queue once before deploying: npx wrangler queues create notify-flow-emails
  "queues": {
    "producers": [{ "binding": "EMAIL_QUEUE", "queue": "notify-flow-emails" }], // binding used in code — do not change
    "consumers": [
      {
        "queue": "notify-flow-emails",
        "max_batch_size": 10,      // messages per consumer call: a few SMTP sessions at most
        "max_batch_timeout": 5,    // seconds to wait for a fuller batch
        "max_retries": 5,          // >= the 4 retries the consumer schedules, so the queue never drops a message first
        "max_concurrency": 2       // parallel consumer calls: few SMTP sessions open on the provider
      }
    ]
  },
```

- [ ] **Step 2: Add `fakeQueue` to `test/helpers.ts`.** Every async test must inject it: the real binding would hand messages to the real consumer and real SMTP.

```ts
/** A Queue that records sent bodies, or throws on send when `fail` is set. */
export function fakeQueue(fail = false): { queue: Queue; sent: any[] } {
  const sent: any[] = [];
  const send = async (body: unknown) => {
    if (fail) throw new Error("queue down");
    sent.push(body);
  };
  return { queue: { send } as unknown as Queue, sent };
}
```

- [ ] **Step 3: Write the failing tests.** Create `test/async-send.test.ts` with the code in [Part 3, "Task 2 tests"](2026-10-11-async-queue-part3.md#task-2-tests).

- [ ] **Step 4: Run the tests.** Command: `npx vitest run test/async-send.test.ts`. Expected: FAIL, with status `200` where `202` is expected.

- [ ] **Step 5: Implement.** The code is in [Part 3, "Task 2 code"](2026-10-11-async-queue-part3.md#task-2-code).

- [ ] **Step 6: Run everything.** Command: `npm test && npm run typecheck`. Expected: all tests pass.

- [ ] **Step 7: Commit.**

```bash
git add wrangler.jsonc.example src/services/email-service.ts src/routes/email.ts test/helpers.ts test/async-send.test.ts
git commit -m "feat: enqueue sends with Prefer: respond-async and answer 202 queued"
```

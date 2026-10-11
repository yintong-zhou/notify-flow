# Async Queue Plan — Part 5: consumer code and GET

[← Part 4](2026-10-11-async-queue-part4.md) · [Part 6: cron, docs →](2026-10-11-async-queue-part6.md)

## Task 3 code

`src/services/queue-consumer.ts` (new file):

```ts
import { resolveSmtpConfig } from "../smtp/provider";
import { SmtpError, type SendMailFn } from "../smtp/smtp-client";
import { checkVariables, render, resolveTemplate } from "../templates/renderer";
import { HttpError } from "../types";
import { mailMessage, type QueuedEmail } from "./email-service";

const MAX_ATTEMPTS = 5;
// Delay before attempts 2-5: about 50 minutes in total, well inside the queue's 24-hour message retention.
const RETRY_DELAYS_S = [60, 300, 900, 1800];

const setStatus = (db: D1Database, id: string, status: "retrying" | "failed", errorCode: string) =>
  db.prepare("UPDATE email_deliveries SET status = ?, error_code = ? WHERE id = ?").bind(status, errorCode, id).run();

/** Queues deliver at least once, so each row is claimed before sending: a redelivered message never sends twice. */
export async function handleQueue(batch: MessageBatch<QueuedEmail>, env: Env, send: SendMailFn): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await deliver(msg, env, send);
    } catch {
      // Safe: if the row was already claimed, the redelivery's claim fails and it is acked without sending.
      msg.retry({ delaySeconds: RETRY_DELAYS_S[0] });
    }
  }
}

async function deliver(msg: Message<QueuedEmail>, env: Env, send: SendMailFn): Promise<void> {
  const job = msg.body;
  const claimed = await env.DB.prepare(
    `UPDATE email_deliveries SET status = 'processing', attempts = attempts + 1, claimed_at = unixepoch()
     WHERE id = ? AND status IN ('queued', 'retrying') RETURNING attempts`,
  )
    .bind(job.id)
    .first<{ attempts: number }>();
  // Already submitted or failed, or being sent by another delivery of the same message.
  if (!claimed) return msg.ack();

  try {
    const config = resolveSmtpConfig(env);
    const template = await resolveTemplate(env.DB, job.clientId, job.template, job.locale);
    checkVariables(template, job.variables);
    await send(config, mailMessage(config, job.id, job.to, render(template, job.variables)));
  } catch (e) {
    const smtp = e instanceof SmtpError ? e : null;
    if (smtp?.transient && claimed.attempts < MAX_ATTEMPTS) {
      await setStatus(env.DB, job.id, "retrying", smtp.code);
      return msg.retry({ delaySeconds: RETRY_DELAYS_S[claimed.attempts - 1] });
    }
    // Permanent, unconfirmed (a retry could send twice), out of attempts, or the template no longer fits.
    const errorCode = smtp?.code ?? (e instanceof HttpError ? e.code : "internal_error");
    await setStatus(env.DB, job.id, "failed", errorCode);
    console.error(JSON.stringify({ id: job.id, client_id: job.clientId, error_code: errorCode }));
    return msg.ack();
  }
  // If this UPDATE throws, handleQueue retries, the claim then fails, and the message is acked: the email is out.
  await env.DB.prepare("UPDATE email_deliveries SET status = 'submitted', error_code = NULL, sent_at = unixepoch() WHERE id = ?")
    .bind(job.id)
    .run();
  msg.ack();
}
```

**`src/index.ts`** changes:
- Add the imports `import type { QueuedEmail } from "./services/email-service";` and `import { handleQueue } from "./services/queue-consumer";`.
- In the default export, add `queue: (batch, env) => handleQueue(batch, env, sendMail),` after `scheduled`.
- Change `satisfies ExportedHandler<Env>` to `satisfies ExportedHandler<Env, QueuedEmail>`.

### Task 4: `GET /v1/email/:id`

**Files:**
- Modify: `src/routes/email.ts`, `src/index.ts`
- Test: `test/async-send.test.ts` (append)

**Interfaces:**
- **Consumes:** `findDelivery` (Task 1), `sendAsync`, `welcome` and `unique` (Task 2).
- **Produces:** `getEmail(env: Env, clientId: string, id: string): Promise<Response>`

- [ ] **Step 1: Write the failing tests.** Append this to `test/async-send.test.ts`:

```ts
describe("GET /v1/email/:id", () => {
  const get = (key: string, id: string, method = "GET") => call(`/v1/email/${id}`, { key, method });

  it("returns the status of the client's own email only", async () => {
    const { key } = await createClient();
    const other = await createClient("other");
    const { id } = await (await sendAsync(key, welcome(unique("get")))).json<any>();
    const res = await get(key, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: "queued", error_code: null });
    for (const [k, path] of [[other.key, id], [key, `msg_${crypto.randomUUID()}`], [key, "not-an-id"]]) {
      const miss = await get(k, path);
      expect(miss.status).toBe(404);
      expect((await miss.json<any>()).error.code).toBe("not_found");
    }
    expect((await get(key, id, "POST")).status).toBe(405);
  });

  it("closes an abandoned processing row but not an old one claimed just now", async () => {
    const { id: clientId, key } = await createClient();
    const insert = async (claimedAt: "NULL" | "unixepoch()") => {
      const id = `msg_${crypto.randomUUID()}`;
      await env.DB.prepare(
        `INSERT INTO email_deliveries (id, request_id, client_id, template, provider, recipient, status, created_at, claimed_at)
         VALUES (?, 'r', ?, 'welcome', 'gmail', 'x@example.com', 'processing', unixepoch() - 3600, ${claimedAt})`,
      )
        .bind(id, clientId)
        .run();
      return id;
    };
    const stale = await insert("NULL");
    const fresh = await insert("unixepoch()");
    expect(await (await get(key, stale)).json()).toEqual({ id: stale, status: "failed", error_code: "abandoned" });
    expect(await (await get(key, fresh)).json()).toEqual({ id: fresh, status: "processing", error_code: null });
  });
});
```

- [ ] **Step 2: Run the tests.** Command: `npx vitest run -t "GET /v1/email"`. Expected: FAIL, with status `404` where `200` is expected.
- [ ] **Step 3: Implement.**
  - In `src/routes/email.ts`, add this. It imports `findDelivery` from `../services/email-service` and `HttpError` from `../types`.

```ts
export async function getEmail(env: Env, clientId: string, id: string): Promise<Response> {
  // Another client's id answers the same 404 as an unknown one, so existence never leaks.
  const delivery = await findDelivery(env.DB, clientId, "id", id);
  if (!delivery) throw new HttpError(404, "not_found", "Email not found");
  return Response.json(delivery);
}
```

  - In `src/index.ts`, import `getEmail` from `./routes/email` and add `const EMAIL_PATH = /^\/v1\/email\/(msg_[0-9a-f-]{36})$/;` next to `TEMPLATE_PATH`. Then insert this after the `/v1/email/send` block:

```ts
    const email = EMAIL_PATH.exec(pathname);
    if (email) {
      allow(req, "GET");
      return await getEmail(env, clientId, email[1]);
    }
```

- [ ] **Step 4: Run everything.** Command: `npm test && npm run typecheck`. Expected: all tests pass.
- [ ] **Step 5: Commit.** `git add src/routes/email.ts src/index.ts test/async-send.test.ts && git commit -m "feat: add GET /v1/email/:id for delivery status"`


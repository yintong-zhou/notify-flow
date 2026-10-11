# Async Queue Plan — Part 3: Task 2 tests and code, consumer

[← Part 2](2026-10-11-async-queue-part2.md) · [Part 4: consumer tests →](2026-10-11-async-queue-part4.md)

## Task 2 tests

`test/async-send.test.ts` (new file). Task 3 and Task 4 append to it.

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, createClient, fakeQueue, recorder } from "./helpers";

const welcome = (to: string, variables: Record<string, string> = { appName: "Acme", name: "Mario" }) => ({ template: "welcome", to, variables });
const unique = (prefix: string) => `${prefix}-${crypto.randomUUID()}@example.com`;
const row = (id: string) =>
  env.DB.prepare("SELECT status, attempts, error_code, sent_at FROM email_deliveries WHERE id = ?").bind(id).first<any>();
const sendAsync = (key: string, body: unknown, q = fakeQueue(), headers: Record<string, string> = { Prefer: "respond-async" }, send = recorder().send) =>
  call("/v1/email/send", { key, method: "POST", body, headers }, send, { ...env, EMAIL_QUEUE: q.queue });

describe("POST /v1/email/send with Prefer: respond-async", () => {
  it("answers 202 queued and enqueues the request, not the rendered email", async () => {
    const { id: clientId, key } = await createClient();
    const q = fakeQueue();
    const rec = recorder();
    const to = unique("async");
    const res = await sendAsync(key, welcome(to), q, undefined, rec.send);
    expect(res.status).toBe(202);
    expect(res.headers.get("Preference-Applied")).toBe("respond-async");
    const body = await res.json<any>();
    expect(body).toEqual({ id: expect.stringMatching(/^msg_/), status: "queued" });
    expect(q.sent).toEqual([{ id: body.id, clientId, template: "welcome", to, locale: "en", variables: { appName: "Acme", name: "Mario" } }]);
    expect(rec.messages).toHaveLength(0);
    expect(await row(body.id)).toMatchObject({ status: "queued", attempts: 0, error_code: null });
  });

  it("recognizes respond-async among other preferences and in any case", async () => {
    const { key } = await createClient();
    expect((await sendAsync(key, welcome(unique("prefer")), fakeQueue(), { Prefer: "wait=5, Respond-Async" })).status).toBe(202);
  });

  it("keeps the sync path without the Prefer header", async () => {
    const { key } = await createClient();
    const q = fakeQueue();
    expect(await (await sendAsync(key, welcome(unique("sync")), q, {})).json()).toMatchObject({ status: "submitted" });
    expect(q.sent).toHaveLength(0);
  });

  it("answers an async replay with 202 and the current status", async () => {
    const { key } = await createClient();
    const to = unique("replay");
    const headers = { Prefer: "respond-async", "Idempotency-Key": "async-key" };
    const q = fakeQueue();
    const first = await (await sendAsync(key, welcome(to), q, headers)).json<any>();
    await env.DB.prepare("UPDATE email_deliveries SET status = 'submitted' WHERE id = ?").bind(first.id).run();
    const replay = await sendAsync(key, welcome(to), q, headers);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ id: first.id, status: "submitted" });
    expect(q.sent).toHaveLength(1);
  });

  it("answers a sync replay of an async key without sending or enqueueing", async () => {
    const { key } = await createClient();
    const to = unique("mixed");
    const q = fakeQueue();
    const rec = recorder();
    const first = await (await sendAsync(key, welcome(to), q, { Prefer: "respond-async", "Idempotency-Key": "mixed-key" })).json<any>();
    const replay = await sendAsync(key, welcome(to), q, { "Idempotency-Key": "mixed-key" }, rec.send);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ id: first.id, status: "queued" });
    expect(rec.messages).toHaveLength(0);
    expect(q.sent).toHaveLength(1);
  });

  it("answers 503 and marks the row failed when the queue is down", async () => {
    const { key } = await createClient();
    const res = await sendAsync(key, welcome(unique("down")), fakeQueue(true));
    expect(res.status).toBe(503);
    const body = await res.json<any>();
    expect(body.error.code).toBe("queue_unavailable");
    expect(await row(body.id)).toMatchObject({ status: "failed", error_code: "enqueue_failed" });
  });

  it("counts queued rows against the recipient limit", async () => {
    const { key } = await createClient();
    const to = unique("limit");
    const q = fakeQueue();
    for (let i = 0; i < 5; i++) expect((await sendAsync(key, welcome(to), q)).status).toBe(202);
    expect((await sendAsync(key, welcome(to), q)).status).toBe(429);
    expect(q.sent).toHaveLength(5);
  });

  it("rejects a message too large for the queue without creating a row", async () => {
    const { id: clientId, key } = await createClient();
    const res = await sendAsync(key, welcome(unique("big"), { appName: "Acme", name: "x".repeat(130 * 1024) }));
    expect(res.status).toBe(413);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_deliveries WHERE client_id = ?").bind(clientId).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });
});
```

## Task 2 code

**`src/services/email-service.ts`**: add this after `sendTemplatedEmail`.

```ts
/** The queue message for an async send: what the consumer needs to render and send, never the rendered email. */
export interface QueuedEmail extends SendRequest {
  id: string;
  clientId: string;
}

// Cloudflare caps a queue message at 128 KB; the margin covers id, clientId and JSON overhead.
const MAX_QUEUED_BYTES = 120 * 1024;
const encoder = new TextEncoder();

export async function enqueueTemplatedEmail(env: Env, clientId: string, request: SendRequest, options: SendOptions): Promise<SendResult> {
  if (encoder.encode(JSON.stringify(request)).byteLength > MAX_QUEUED_BYTES) {
    throw new HttpError(413, "payload_too_large", "Variables are too large for an async send");
  }
  const reserved = await reserveDelivery(env, clientId, request, options, "queued");
  if ("status" in reserved) return reserved;
  const { id } = reserved;
  try {
    await env.EMAIL_QUEUE.send({ id, clientId, ...request } satisfies QueuedEmail, { contentType: "json" });
  } catch {
    // Failed rows don't count against the recipient limit, so the caller can simply retry.
    await env.DB.prepare("UPDATE email_deliveries SET status = 'failed', error_code = 'enqueue_failed' WHERE id = ?").bind(id).run();
    console.error(JSON.stringify({ id, client_id: clientId, error_code: "enqueue_failed" }));
    throw new HttpError(503, "queue_unavailable", "The send queue is unavailable: retry later", { id });
  }
  return { id, status: "queued" };
}
```

**`src/routes/email.ts`**:
- Import `enqueueTemplatedEmail` next to `sendTemplatedEmail`.
- In `sendEmail`, insert this after the `requestId` line:

```ts
  // RFC 7240: preference names are case-insensitive, and Prefer may list several.
  if (/\brespond-async\b/i.test(req.headers.get("Prefer") ?? "")) {
    const queued = await enqueueTemplatedEmail(env, clientId, request, { idempotencyKey, requestId });
    return Response.json(queued, { status: 202, headers: { "Preference-Applied": "respond-async" } });
  }
```

---

### Task 3: Consumer (`handleQueue`)

**Files:**
- Create: `src/services/queue-consumer.ts`
- Modify: `src/index.ts`
- Test: `test/async-send.test.ts` (append)

**Interfaces:**
- **Consumes:** `QueuedEmail`, `mailMessage` (Tasks 1–2); `fakeQueue` and the test helpers `welcome`, `unique`, `row`, `sendAsync` (Task 2).
- **Produces:** `handleQueue(batch: MessageBatch<QueuedEmail>, env: Env, send: SendMailFn): Promise<void>`

- [ ] **Step 1: Write the failing tests.** Append the tests from [Part 4, "Task 3 tests"](2026-10-11-async-queue-part4.md#task-3-tests) to `test/async-send.test.ts`.
- [ ] **Step 2: Run the tests.** Command: `npx vitest run test/async-send.test.ts`. Expected: FAIL, because `../src/services/queue-consumer` cannot be resolved.
- [ ] **Step 3: Implement.** Create `src/services/queue-consumer.ts` and change `src/index.ts`, using [Part 5, "Task 3 code"](2026-10-11-async-queue-part5.md#task-3-code).
- [ ] **Step 4: Run everything.** Command: `npm test && npm run typecheck`. Expected: all tests pass.
- [ ] **Step 5: Commit.**

```bash
git add src/services/queue-consumer.ts src/index.ts test/async-send.test.ts
git commit -m "feat: consume the email queue with an atomic claim and delayed retries"
```

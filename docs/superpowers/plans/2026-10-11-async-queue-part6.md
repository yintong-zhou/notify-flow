# Async Queue Plan — Part 6: cron and docs

[← Part 5](2026-10-11-async-queue-part5.md) · [Part 1](2026-10-11-async-queue.md)

### Task 5: Close stuck queued rows in the daily cron

**Files:**
- Modify: `src/services/email-service.ts` (`purgeDeliveries`)
- Test: `test/async-send.test.ts` (append)

- [ ] **Step 1: Write the failing test.** Add `purgeDeliveries` to the `../src/services/email-service` import, then append:

```ts
describe("purgeDeliveries and stuck queued rows", () => {
  it("closes queued and retrying rows older than 24 hours and keeps recent ones", async () => {
    const { id: clientId } = await createClient();
    const ids: Record<string, string> = {};
    for (const [name, status, age] of [["oldQueued", "queued", 90000], ["oldRetrying", "retrying", 90000], ["newQueued", "queued", 3600]] as const) {
      ids[name] = `msg_${crypto.randomUUID()}`;
      await env.DB.prepare(
        `INSERT INTO email_deliveries (id, request_id, client_id, template, provider, recipient, status, created_at)
         VALUES (?, 'r', ?, 'welcome', 'gmail', 'x@example.com', ?, unixepoch() - ?)`,
      )
        .bind(ids[name], clientId, status, age)
        .run();
    }
    await purgeDeliveries(env.DB);
    expect(await row(ids.oldQueued)).toMatchObject({ status: "failed", error_code: "abandoned" });
    expect(await row(ids.oldRetrying)).toMatchObject({ status: "failed", error_code: "abandoned" });
    expect(await row(ids.newQueued)).toMatchObject({ status: "queued", error_code: null });
  });
});
```

- [ ] **Step 2: Run the test.** Command: `npx vitest run -t "stuck queued"`. Expected: FAIL, because the old rows are still `queued` or `retrying`.
- [ ] **Step 3: Implement.** In `src/services/email-service.ts`, add this above `purgeDeliveries`, then call it as the first line of `purgeDeliveries` (and add "Closes stuck queued rows, then" to its doc comment):

```ts
// The queue keeps a message for 24 hours at most: an older queued or retrying row will never be sent.
const STALE_QUEUED_S = 24 * 3600;

async function closeStaleQueued(db: D1Database): Promise<void> {
  await db
    .prepare(
      "UPDATE email_deliveries SET status = 'failed', error_code = 'abandoned' WHERE status IN ('queued', 'retrying') AND created_at < unixepoch() - ?",
    )
    .bind(STALE_QUEUED_S)
    .run();
}
```

  The first line of `purgeDeliveries` becomes `await closeStaleQueued(db);`.
- [ ] **Step 4: Run everything.** Command: `npm test && npm run typecheck`. Expected: all tests pass.
- [ ] **Step 5: Commit.** `git add src/services/email-service.ts test/async-send.test.ts && git commit -m "feat: close queued rows stuck for more than 24 hours"`

### Task 6: Documentation

Every file stays under 200 lines; check with `wc -l`.

- [ ] **Step 1: Create `docs/web-app-integration-async.md`** (about 60 lines). Its sections:
  - **Title, and when to use async:** fast response, and the email survives an SMTP outage.
  - **Request:** the same `POST /v1/email/send` with `Prefer: respond-async`. Show a `curl` call.
  - **Response:** `202 {"id","status":"queued"}` with `Preference-Applied: respond-async`. A replay of the same `Idempotency-Key` answers `202` with the current status.
  - **Statuses:** a table of `queued` → `processing` → `submitted`, `retrying` (up to 5 attempts in about 50 minutes), and `failed`, with `error_code` values `smtp_*`, `template_not_found`, `invalid_variables`, `enqueue_failed` and `abandoned`.
  - **Polling:** `GET /v1/email/:id` → `200 {"id","status","error_code"}`, or `404 not_found` for an unknown id or another app's id.
  - **Errors:** a table with only the new ones: `202`; `413` (variables over 120 KB); `503 queue_unavailable` (the response includes `id`, the row is `failed`, retry with a new request).
  - **Changes at send time:** the template is rendered when the email is sent, so a template edited in the meantime is sent in its new version.
  - **Link** back to `web-app-integration.md`.
- [ ] **Step 2: `docs/web-app-integration.md`.** Below the error table, add one line: `For asynchronous sending (\`202 Accepted\`, \`GET /v1/email/:id\`), see [Asynchronous sending](web-app-integration-async.md).`
- [ ] **Step 3: `README.md`.**
  - After `npm run db:migrate:remote` in "Getting started", add `npx wrangler queues create notify-flow-emails`.
  - In "Send an email", add the bullet `- **Async:** add \`Prefer: respond-async\` to get \`202\` with \`queued\`, then read the outcome with \`GET /v1/email/:id\` ([guide](docs/web-app-integration-async.md)).`
  - Remove the Queues bullet from "Roadmap".
- [ ] **Step 4: `CLAUDE.md`.**
  - In "Architecture", after the request-flow line, add `Async (\`Prefer: respond-async\`): the route enqueues to \`EMAIL_QUEUE\` and answers \`202 queued\`; the same Worker's \`queue()\` handler (\`services/queue-consumer.ts\`) claims the row atomically, renders and sends once, then acks or retries (5 attempts).`
  - In the testing note, add `handleQueue(batch, env, send)` and `fakeQueue()` to the injected examples.
  - In "Not in the MVP", remove `Cloudflare Queues (API Worker → Queue → Email Worker, returning \`202\` with \`queued\`), `.
- [ ] **Step 5: Verify and commit.**

```bash
wc -l README.md CLAUDE.md docs/web-app-integration*.md
git add README.md CLAUDE.md docs/web-app-integration.md docs/web-app-integration-async.md
git commit -m "docs: document async sending with Prefer: respond-async"
```

**Deploy (manual, after merge):**
1. `npx wrangler queues create notify-flow-emails`
2. `npm run db:migrate:remote` (migration `0004`)
3. `npm run deploy`

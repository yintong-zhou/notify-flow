# Async Queue Plan — Part 4: consumer tests

[← Part 3](2026-10-11-async-queue-part3.md) · [Part 5: consumer code, GET →](2026-10-11-async-queue-part5.md)

## Task 3 tests

Merge these imports into the top of `test/async-send.test.ts`:

```ts
import type { QueuedEmail } from "../src/services/email-service";
import { handleQueue } from "../src/services/queue-consumer";
import { SmtpError, type SendMailFn } from "../src/smtp/smtp-client";
```

Append this:

```ts
interface Outcome {
  acked: boolean;
  retries: (QueueRetryOptions | undefined)[];
}

function message(body: QueuedEmail): { msg: Message<QueuedEmail>; outcome: Outcome } {
  const outcome: Outcome = { acked: false, retries: [] };
  const msg = {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: () => { outcome.acked = true; },
    retry: (options?: QueueRetryOptions) => { outcome.retries.push(options); },
  } as unknown as Message<QueuedEmail>;
  return { msg, outcome };
}

const consume = (send: SendMailFn, msgs: Message<QueuedEmail>[], testEnv: Env = env) =>
  handleQueue({ queue: "notify-flow-emails", messages: msgs } as unknown as MessageBatch<QueuedEmail>, testEnv, send);

/** Enqueues a real async send through the API and returns the queue message body. */
async function queued(): Promise<QueuedEmail> {
  const { key } = await createClient();
  const q = fakeQueue();
  expect((await sendAsync(key, welcome(unique("consume")), q)).status).toBe(202);
  return q.sent[0];
}

const transient = () => new SmtpError("smtp_timeout", true, "SMTP command timed out");

describe("handleQueue", () => {
  it("sends a queued email and acks it", async () => {
    const body = await queued();
    const rec = recorder();
    const { msg, outcome } = message(body);
    await consume(rec.send, [msg]);
    expect(outcome).toEqual({ acked: true, retries: [] });
    expect(rec.messages).toHaveLength(1);
    expect(rec.messages[0].to).toBe(body.to);
    expect(rec.messages[0].messageId.startsWith(`${body.id}@`)).toBe(true);
    expect(await row(body.id)).toMatchObject({ status: "submitted", attempts: 1, error_code: null, sent_at: expect.any(Number) });
  });

  it("never sends a redelivered message twice", async () => {
    const body = await queued();
    const rec = recorder();
    const first = message(body);
    const second = message(body);
    await consume(rec.send, [first.msg, second.msg]);
    expect(rec.messages).toHaveLength(1);
    expect([first.outcome.acked, second.outcome.acked]).toEqual([true, true]);
  });

  it("schedules a delayed retry on a transient failure, then clears the error on success", async () => {
    const body = await queued();
    const first = message(body);
    await consume(recorder(transient()).send, [first.msg]);
    expect(first.outcome).toEqual({ acked: false, retries: [{ delaySeconds: 60 }] });
    expect(await row(body.id)).toMatchObject({ status: "retrying", attempts: 1, error_code: "smtp_timeout" });

    const second = message(body);
    await consume(recorder().send, [second.msg]);
    expect(second.outcome.acked).toBe(true);
    expect(await row(body.id)).toMatchObject({ status: "submitted", attempts: 2, error_code: null });
  });

  it("fails after the 5th transient failure, with growing delays", async () => {
    const body = await queued();
    const delays: unknown[] = [];
    let lastAcked = false;
    for (let i = 0; i < 5; i++) {
      const { msg, outcome } = message(body);
      await consume(recorder(transient()).send, [msg]);
      delays.push(...outcome.retries.map((r) => r?.delaySeconds));
      lastAcked = outcome.acked;
    }
    expect(delays).toEqual([60, 300, 900, 1800]);
    expect(lastAcked).toBe(true);
    expect(await row(body.id)).toMatchObject({ status: "failed", attempts: 5, error_code: "smtp_timeout" });
  });

  it("does not retry a permanent or unconfirmed failure", async () => {
    for (const error of [new SmtpError("smtp_rejected", false, "SMTP 550"), new SmtpError("smtp_unconfirmed", false, "No reply")]) {
      const body = await queued();
      const { msg, outcome } = message(body);
      await consume(recorder(error).send, [msg]);
      expect(outcome).toEqual({ acked: true, retries: [] });
      expect(await row(body.id)).toMatchObject({ status: "failed", error_code: error.code });
    }
  });

  it("fails without sending when the template no longer fits", async () => {
    const cases: [Partial<QueuedEmail>, string][] = [
      [{ template: "no-such-template" }, "template_not_found"],
      [{ variables: {} }, "invalid_variables"],
    ];
    for (const [change, code] of cases) {
      const body = await queued();
      const rec = recorder();
      const { msg, outcome } = message({ ...body, ...change });
      await consume(rec.send, [msg]);
      expect(outcome.acked).toBe(true);
      expect(rec.messages).toHaveLength(0);
      expect(await row(body.id)).toMatchObject({ status: "failed", error_code: code });
    }
  });

  it("retries a message whose claim fails and still delivers the rest of the batch", async () => {
    const bad = await queued();
    const good = await queued();
    const DB = {
      prepare: (sql: string) => {
        const stmt = env.DB.prepare(sql);
        return {
          bind: (...args: unknown[]) => {
            if (args.includes(bad.id)) throw new Error("D1 down");
            return stmt.bind(...args);
          },
        };
      },
    } as unknown as D1Database;
    const rec = recorder();
    const b = message(bad);
    const g = message(good);
    await consume(rec.send, [b.msg, g.msg], { ...env, DB });
    expect(b.outcome).toEqual({ acked: false, retries: [{ delaySeconds: 60 }] });
    expect(g.outcome.acked).toBe(true);
    expect(rec.messages.map((m) => m.to)).toEqual([good.to]);
    expect(await row(bad.id)).toMatchObject({ status: "queued", attempts: 0 });
  });
});
```

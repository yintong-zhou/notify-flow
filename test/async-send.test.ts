import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { QueuedEmail } from "../src/services/email-service";
import { handleQueue } from "../src/services/queue-consumer";
import { SmtpError, type SendMailFn } from "../src/smtp/smtp-client";
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

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

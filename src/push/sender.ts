import { ABANDONED_AFTER_S, type SendOptions } from "../services/email-service";
import { log } from "../services/logger";
import { checkVariables } from "../templates/renderer";
import { HttpError, type Locale } from "../types";
import { b64url, encryptPayload, vapidAuthorization, vapidKeys, type VapidKeys } from "./crypto";
import type { PushFetch } from "./routes";
import { deleteSubscription, listSubscriptions, type Subscription } from "./subscriptions";
import { renderPush, resolvePushTemplate } from "./templates";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1000];
const ATTEMPT_TIMEOUT_MS = 5000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();

export interface PushRequest {
  userId: string;
  template: string;
  locale: Locale;
  variables: Record<string, string>;
  url?: string;
  tag?: string;
}

export interface PushResult {
  id: string;
  status: "processing" | "submitted" | "failed";
  devices: number;
}

type Outcome = "accepted" | "gone" | "failed";

/** The stored result for an Idempotency-Key. A `processing` row created more than ABANDONED_AFTER_S ago is closed as failed. */
async function findReplay(db: D1Database, clientId: string, key: string | null): Promise<PushResult | null> {
  if (key === null) return null;
  const row = await db
    .prepare("SELECT id, status, devices, created_at < unixepoch() - ? AS abandoned FROM push_deliveries WHERE client_id = ? AND idempotency_key = ?")
    .bind(ABANDONED_AFTER_S, clientId, key)
    .first<PushResult & { abandoned: number }>();
  if (!row) return null;
  if (row.status === "processing" && row.abandoned) {
    // The send died midway (e.g. the runtime was cancelled). The push may or may not have gone out.
    await db
      .prepare("UPDATE push_deliveries SET status = 'failed', error_code = 'abandoned' WHERE id = ? AND status = 'processing'")
      .bind(row.id)
      .run();
    return { id: row.id, status: "failed", devices: row.devices };
  }
  return { id: row.id, status: row.status, devices: row.devices };
}

/**
 * Inserts the `processing` row, with the hourly limit counted in the same statement so a concurrent burst cannot
 * exceed it. The limit is per client, user and conversation (the tag, or the template when untagged); failed rows
 * don't count.
 */
async function reserve(env: Env, clientId: string, request: PushRequest, options: SendOptions): Promise<PushResult | { id: string }> {
  const id = `psh_${crypto.randomUUID()}`;
  const { meta } = await env.DB.prepare(
    `INSERT INTO push_deliveries (id, request_id, client_id, idempotency_key, template, user_id, tag, status, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'processing', unixepoch()
     WHERE (SELECT COUNT(*) FROM push_deliveries
            WHERE client_id = ?3 AND user_id = ?6 AND status != 'failed' AND created_at > unixepoch() - 3600
              AND ((?7 IS NULL AND tag IS NULL AND template = ?5) OR tag = ?7)) < ?8
     ON CONFLICT (client_id, idempotency_key) DO NOTHING`,
  )
    .bind(
      id,
      options.requestId,
      clientId,
      options.idempotencyKey,
      request.template,
      request.userId,
      request.tag ?? null,
      Number(env.PUSH_LIMIT_PER_HOUR || 60),
    )
    .run();
  if (meta.changes === 0) {
    // A concurrent request with the same Idempotency-Key won the insert (NULL keys never conflict), or the limit is reached.
    const existing = await findReplay(env.DB, clientId, options.idempotencyKey);
    if (existing) return existing;
    throw new HttpError(429, "rate_limited", "Too many push notifications for this user and conversation");
  }
  return { id };
}

/** Encrypts once, then POSTs to one device's push service, retrying transient failures. Never logs the endpoint. */
async function deliver(
  env: Env,
  clientId: string,
  id: string,
  sub: Subscription,
  payload: Uint8Array,
  tag: string | undefined,
  keys: VapidKeys,
  fetchPush: PushFetch,
): Promise<Outcome> {
  const body = await encryptPayload(payload, b64url.decode(sub.p256dh), b64url.decode(sub.auth));
  // Signed once (the JWT is valid 12 h). Signing and D1 errors are not transient: they skip the retries.
  const headers: Record<string, string> = {
    TTL: "86400",
    Urgency: "high",
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    Authorization: await vapidAuthorization(sub.endpoint, keys),
  };
  if (tag) headers.Topic = tag;
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    try {
      // redirect: "manual": a 3xx must not re-send the payload to a URL outside the allowlist (it counts as a permanent failure).
      res = await fetchPush(sub.endpoint, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
    } catch {
      // network error or timeout; the error's message is not logged: it could name the endpoint
    }
    // Only the status is used: release the connection (Workers allows 6 at once). A cancel failure is ignored.
    await res?.body?.cancel().catch(() => {});
    if (res?.ok) return "accepted";
    if (res && (res.status === 404 || res.status === 410)) {
      await deleteSubscription(env.DB, clientId, sub.endpoint);
      return "gone";
    }
    const transient = !res || res.status === 429 || res.status >= 500;
    const detail = res ? `HTTP ${res.status}` : "network";
    await log(env.DB, { level: "warn", code: "push_attempt_failed", client_id: clientId, message_id: id, detail: `${detail} attempt ${attempt}/${MAX_ATTEMPTS}` });
    if (!transient || attempt === MAX_ATTEMPTS) return "failed";
    await sleep(BACKOFF_MS[attempt - 1]);
  }
}

export async function sendPush(env: Env, clientId: string, request: PushRequest, options: SendOptions, fetchPush: PushFetch): Promise<PushResult> {
  const keys = vapidKeys(env);
  if (!keys) throw new HttpError(503, "push_not_configured", "Web Push is not configured on this service");
  const template = resolvePushTemplate(request.template, request.locale);
  checkVariables(template, request.variables);

  // Replays are answered before the limit, so a retrying backend always gets the original result.
  const replay = await findReplay(env.DB, clientId, options.idempotencyKey);
  if (replay) return replay;
  const subscriptions = await listSubscriptions(env.DB, clientId, request.userId);
  if (subscriptions.length === 0) throw new HttpError(404, "no_subscriptions", "The user has no registered devices");
  const reserved = await reserve(env, clientId, request, options);
  if ("status" in reserved) return reserved;
  const { id } = reserved;

  const { title, body } = renderPush(template, request.variables);
  // undefined keys drop out of the JSON: the payload is title and body, plus url and tag when given.
  const payload = encoder.encode(JSON.stringify({ title, body, url: request.url, tag: request.tag }));
  const outcomes = await Promise.all(
    subscriptions.map((sub) =>
      deliver(env, clientId, id, sub, payload, request.tag, keys, fetchPush).catch(async (): Promise<Outcome> => {
        // An unexpected error (e.g. D1) on one device must not leave the row `processing` or lose the others.
        await log(env.DB, { level: "error", code: "push_device_error", client_id: clientId, message_id: id });
        return "failed";
      }),
    ),
  );

  const accepted = outcomes.filter((o) => o === "accepted").length;
  if (accepted > 0) {
    // Outside any catch: the push is out, so a D1 error here must not mark the row failed (the caller could resend).
    await env.DB.prepare("UPDATE push_deliveries SET status = 'submitted', devices = ?, sent_at = unixepoch() WHERE id = ?").bind(accepted, id).run();
    return { id, status: "submitted", devices: accepted };
  }
  const expired = outcomes.every((o) => o === "gone");
  await env.DB.prepare("UPDATE push_deliveries SET status = 'failed', error_code = ? WHERE id = ?")
    .bind(expired ? "push_expired" : "push_failed", id)
    .run();
  if (expired) throw new HttpError(404, "no_subscriptions", "The user's devices are no longer registered", { id });
  throw new HttpError(502, "push_failed", "No push service accepted the notification", { id });
}

// Same retention as email_deliveries: well past the 1-hour limit window.
const RETENTION_S = 30 * 24 * 3600;
const PURGE_BATCH = 1000;

/** Closes rows stuck `processing`, then deletes rows older than RETENTION_S, in batches. */
export async function purgePushDeliveries(db: D1Database): Promise<void> {
  await db
    .prepare("UPDATE push_deliveries SET status = 'failed', error_code = 'abandoned' WHERE status = 'processing' AND created_at < unixepoch() - ?")
    .bind(ABANDONED_AFTER_S)
    .run();
  for (;;) {
    const { meta } = await db
      .prepare("DELETE FROM push_deliveries WHERE id IN (SELECT id FROM push_deliveries WHERE created_at < unixepoch() - ? LIMIT ?)")
      .bind(RETENTION_S, PURGE_BATCH)
      .run();
    if (meta.changes < PURGE_BATCH) return;
  }
}

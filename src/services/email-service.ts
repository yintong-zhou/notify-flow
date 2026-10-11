import type { SendRequest } from "../security/validation";
import { resolveSmtpConfig, type SmtpConfig } from "../smtp/provider";
import { SmtpError, type MailMessage, type SendMailFn } from "../smtp/smtp-client";
import { checkVariables, render, resolveTemplate, type Rendered } from "../templates/renderer";
import { HttpError, type DeliveryStatus, type Template } from "../types";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1000];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SendResult {
  id: string;
  status: DeliveryStatus;
}

export interface Delivery extends SendResult {
  error_code: string | null;
}

export interface SendOptions {
  idempotencyKey: string | null;
  requestId: string;
}

// Longer than the worst-case send (3 attempts x per-command timeouts + backoff), so only truly abandoned rows match.
const ABANDONED_AFTER_S = 300;

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

// Well past the 1-hour recipient window; an Idempotency-Key older than this is forgotten.
const RETENTION_S = 30 * 24 * 3600;
const PURGE_BATCH = 1000;

/** Deletes delivery rows older than RETENTION_S, in batches so one statement never holds the write lock for long. */
export async function purgeDeliveries(db: D1Database): Promise<void> {
  for (;;) {
    const { meta } = await db
      .prepare(
        "DELETE FROM email_deliveries WHERE id IN (SELECT id FROM email_deliveries WHERE created_at < unixepoch() - ? LIMIT ?)",
      )
      .bind(RETENTION_S, PURGE_BATCH)
      .run();
    if (meta.changes < PURGE_BATCH) return;
  }
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
    .bind(
      id,
      options.requestId,
      clientId,
      options.idempotencyKey,
      request.template,
      config.provider,
      request.to,
      Number(env.RECIPIENT_LIMIT_PER_HOUR || 5),
      status,
    )
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

  for (let attempt = 1; ; attempt++) {
    try {
      await send(config, message);
    } catch (e) {
      const smtp = e instanceof SmtpError ? e : null;
      if (smtp?.transient && attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS[attempt - 1]);
        continue;
      }
      const errorCode = smtp?.code ?? "internal_error";
      await env.DB.prepare("UPDATE email_deliveries SET status = 'failed', attempts = ?, error_code = ? WHERE id = ?")
        .bind(attempt, errorCode, id)
        .run();
      console.error(JSON.stringify({ id, client_id: clientId, error_code: errorCode }));
      if (!smtp) throw e;
      const message =
        smtp.code === "smtp_unconfirmed"
          ? "The SMTP server did not confirm the message: it may still be delivered"
          : "The SMTP server did not accept the message";
      throw new HttpError(502, "smtp_failed", message, { id });
    }
    // Outside the try: the email is out, so a D1 error here must not mark the row failed (the caller could resend).
    await env.DB.prepare("UPDATE email_deliveries SET status = 'submitted', attempts = ?, sent_at = unixepoch() WHERE id = ?")
      .bind(attempt, id)
      .run();
    return { id, status: "submitted" };
  }
}

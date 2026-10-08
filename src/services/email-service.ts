import { checkRecipientLimit } from "../security/rate-limit";
import type { SendRequest } from "../security/validation";
import { resolveSmtpConfig } from "../smtp/provider";
import { SmtpError, type SendMailFn } from "../smtp/smtp-client";
import { checkVariables, render, resolveTemplate } from "../templates/renderer";
import { HttpError, type DeliveryStatus } from "../types";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1000];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SendResult {
  id: string;
  status: DeliveryStatus;
}

// Longer than the worst-case send (3 attempts x per-command timeouts + backoff), so only truly abandoned rows match.
const ABANDONED_AFTER_S = 300;

/** The stored result for an idempotency key; a `processing` row older than ABANDONED_AFTER_S is closed as failed. */
async function findByIdempotencyKey(db: D1Database, clientId: string, key: string): Promise<SendResult | null> {
  const row = await db
    .prepare(
      "SELECT id, status, created_at < unixepoch() - ? AS abandoned FROM email_deliveries WHERE client_id = ? AND idempotency_key = ?",
    )
    .bind(ABANDONED_AFTER_S, clientId, key)
    .first<SendResult & { abandoned: number }>();
  if (!row) return null;
  if (row.status === "processing" && row.abandoned) {
    // The request died mid-send (e.g. the runtime was cancelled). The email may or may not have gone out.
    await db
      .prepare("UPDATE email_deliveries SET status = 'failed', error_code = 'abandoned' WHERE id = ? AND status = 'processing'")
      .bind(row.id)
      .run();
    return { id: row.id, status: "failed" };
  }
  return { id: row.id, status: row.status };
}

export async function sendTemplatedEmail(
  env: Env,
  clientId: string,
  request: SendRequest,
  options: { idempotencyKey: string | null; requestId: string },
  send: SendMailFn,
): Promise<SendResult> {
  const config = resolveSmtpConfig(env);
  const template = await resolveTemplate(env.DB, clientId, request.template, request.locale);
  checkVariables(template, request.variables);

  // Replays are answered before the recipient limit, so a retrying backend always gets the original result.
  if (options.idempotencyKey !== null) {
    const existing = await findByIdempotencyKey(env.DB, clientId, options.idempotencyKey);
    if (existing) return existing;
  }
  await checkRecipientLimit(env, clientId, request.to, request.template);

  const id = `msg_${crypto.randomUUID()}`;
  const { meta } = await env.DB.prepare(
    `INSERT INTO email_deliveries (id, request_id, client_id, idempotency_key, template, provider, recipient, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', unixepoch())
     ON CONFLICT (client_id, idempotency_key) DO NOTHING`,
  )
    .bind(id, options.requestId, clientId, options.idempotencyKey, request.template, config.provider, request.to)
    .run();
  if (meta.changes === 0) {
    // A concurrent request with the same Idempotency-Key won the insert (NULL keys never conflict).
    return (await findByIdempotencyKey(env.DB, clientId, options.idempotencyKey!))!;
  }

  const message = {
    from: config.from,
    fromName: config.fromName,
    to: request.to,
    messageId: `${id}@${config.from.slice(config.from.lastIndexOf("@") + 1)}`,
    ...render(template, request.variables),
  };

  for (let attempt = 1; ; attempt++) {
    try {
      await send(config, message);
      await env.DB.prepare("UPDATE email_deliveries SET status = 'submitted', attempts = ?, sent_at = unixepoch() WHERE id = ?")
        .bind(attempt, id)
        .run();
      return { id, status: "submitted" };
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
      throw new HttpError(502, "smtp_failed", "The SMTP server did not accept the message", { id });
    }
  }
}

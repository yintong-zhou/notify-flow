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

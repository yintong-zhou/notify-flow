import { resolveSmtpConfig } from "../smtp/provider";
import { SmtpError, type SendMailFn } from "../smtp/smtp-client";
import { checkVariables, render, resolveTemplate } from "../templates/renderer";
import { HttpError } from "../types";
import { mailMessage, type QueuedEmail } from "./email-service";

type Outcome = NonNullable<QueuedEmail["resume"]>["status"];

const MAX_ATTEMPTS = 5;
// Delay before attempts 2-5: about 50 minutes in total, well inside the queue's 24-hour message retention.
const RETRY_DELAYS_S = [60, 300, 900, 1800];

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
  if (job.resume && !(await applyResume(msg, env))) return;
  const claimed = await env.DB.prepare(
    `UPDATE email_deliveries SET status = 'processing', attempts = attempts + 1, claimed_at = unixepoch()
     WHERE id = ? AND status IN ('queued', 'retrying') RETURNING attempts`,
  )
    .bind(job.id)
    .first<{ attempts: number }>();
  // Already submitted or failed, or being sent by another delivery of the same message.
  if (!claimed) return msg.ack();
  const { attempts } = claimed;

  try {
    const config = resolveSmtpConfig(env);
    const template = await resolveTemplate(env.DB, job.clientId, job.template, job.locale);
    checkVariables(template, job.variables);
    await send(config, mailMessage(config, job.id, job.to, render(template, job.variables)));
  } catch (e) {
    const smtp = e instanceof SmtpError ? e : null;
    if (smtp?.transient && attempts < MAX_ATTEMPTS) {
      if (await record(msg, env, attempts, "retrying", smtp.code)) msg.retry({ delaySeconds: RETRY_DELAYS_S[attempts - 1] });
      return;
    }
    // Permanent, unconfirmed (a retry could send twice), out of attempts, or the template no longer fits.
    const errorCode = smtp?.code ?? (e instanceof HttpError ? e.code : "internal_error");
    console.error(JSON.stringify({ id: job.id, client_id: job.clientId, error_code: errorCode }));
    if (await record(msg, env, attempts, "failed", errorCode)) msg.ack();
    return;
  }
  if (await record(msg, env, attempts, "submitted", null)) msg.ack();
}

/**
 * Records the claimed attempt's outcome. If D1 fails, the outcome travels in a resume message instead: a plain retry
 * would find the row `processing` and drop it, losing the remaining attempts or misreporting a sent email.
 * Returns false when it handed off (the original message is then acked).
 */
async function record(msg: Message<QueuedEmail>, env: Env, attempts: number, status: Outcome, errorCode: string | null): Promise<boolean> {
  const { resume: _, ...job } = msg.body;
  try {
    const sql =
      status === "submitted"
        ? "UPDATE email_deliveries SET status = 'submitted', error_code = NULL, sent_at = unixepoch() WHERE id = ?"
        : "UPDATE email_deliveries SET status = ?, error_code = ? WHERE id = ?";
    const stmt = env.DB.prepare(sql);
    await (status === "submitted" ? stmt.bind(job.id) : stmt.bind(status, errorCode, job.id)).run();
    return true;
  } catch {
    // ponytail: if the queue is down too, this throws and handleQueue's retry drops the row as before (it ends up
    // abandoned, never sent twice). An outbox table would cover that double outage.
    await env.EMAIL_QUEUE.send({ ...job, resume: { attempts, status, errorCode } } satisfies QueuedEmail, { contentType: "json" });
    msg.ack();
    return false;
  }
}

/**
 * Applies a resume message's transition. `attempts` is the claim token: a duplicate resume, or a row a later attempt
 * already moved on, is left alone. Returns true when the message should continue as a normal delivery.
 */
async function applyResume(msg: Message<QueuedEmail>, env: Env): Promise<boolean> {
  const { id, resume } = msg.body;
  const { attempts, status, errorCode } = resume!;
  // A sent email may also correct a row closed as abandoned meanwhile: we know it went out.
  const from = status === "submitted" ? "(status = 'processing' OR (status = 'failed' AND error_code = 'abandoned'))" : "status = 'processing'";
  const sentAt = status === "submitted" ? ", sent_at = unixepoch()" : "";
  const { meta } = await env.DB.prepare(
    `UPDATE email_deliveries SET status = ?, error_code = ?${sentAt} WHERE id = ? AND attempts = ? AND ${from}`,
  )
    .bind(status, errorCode, id, attempts)
    .run();
  if (status !== "retrying") {
    msg.ack();
    return false;
  }
  if (meta.changes > 0) {
    msg.retry({ delaySeconds: RETRY_DELAYS_S[attempts - 1] });
    return false;
  }
  // Already retrying: this is the delayed redelivery, so it is now a normal attempt.
  return true;
}

import { HttpError } from "../types";

export async function checkClientLimit(env: Env, clientId: string): Promise<void> {
  const { success } = await env.CLIENT_RATE_LIMITER.limit({ key: clientId });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests for this client");
}

export async function checkRecipientLimit(env: Env, recipient: string, template: string): Promise<void> {
  // ponytail: count-then-insert is not atomic; a concurrent burst can exceed the limit by a few. Fold the count into
  // the INSERT if that ever matters.
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM email_deliveries WHERE recipient = ? AND template = ? AND created_at > unixepoch() - 3600",
  )
    .bind(recipient, template)
    .first<{ n: number }>();
  const limit = Number(env.RECIPIENT_LIMIT_PER_HOUR) || 5;
  if ((row?.n ?? 0) >= limit) throw new HttpError(429, "rate_limited", "Too many emails for this recipient and template");
}

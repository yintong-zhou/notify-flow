import { HttpError } from "../types";

export async function checkClientLimit(env: Env, clientId: string): Promise<void> {
  const { success } = await env.CLIENT_RATE_LIMITER.limit({ key: clientId });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests for this client");
}

import { HttpError } from "../types";

/** Runs before authentication, so invalid keys cannot reach D1 unthrottled. Cloudflare always sets the header. */
export async function checkIpLimit(env: Env, req: Request): Promise<void> {
  const ip = req.headers.get("CF-Connecting-IP");
  if (!ip) return;
  const { success } = await env.IP_RATE_LIMITER.limit({ key: ip });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests from this IP");
}

export async function checkClientLimit(env: Env, clientId: string): Promise<void> {
  const { success } = await env.CLIENT_RATE_LIMITER.limit({ key: clientId });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests for this client");
}

/** Slows password guessing on admin setup, login and password change. */
export async function checkAdminLimit(env: Env, req: Request): Promise<void> {
  const ip = req.headers.get("CF-Connecting-IP");
  if (!ip) return;
  const { success } = await env.ADMIN_RATE_LIMITER.limit({ key: ip });
  if (!success) throw new HttpError(429, "rate_limited", "Too many attempts from this IP");
}

/** Push has its own budget, so chat traffic can never cause a 429 on email. */
export async function checkPushLimit(env: Env, clientId: string): Promise<void> {
  const { success } = await env.PUSH_RATE_LIMITER.limit({ key: clientId });
  if (!success) throw new HttpError(429, "rate_limited", "Too many push requests for this client");
}

import { HttpError } from "../types";

export interface LogEvent {
  level: "error" | "warn" | "info";
  code: string;
  status?: number;
  method?: string;
  path?: string;
  client_id?: string;
  message_id?: string;
  ip?: string;
  detail?: string;
}

const RETENTION_S = 30 * 24 * 3600;
const PURGE_BATCH = 1000;

/** Writes one app_logs row. Never throws: logging must not fail a send or change a response. */
export async function log(db: D1Database, event: LogEvent): Promise<void> {
  const e = { ...event, path: event.path?.slice(0, 128) };
  console.log(JSON.stringify(e));
  try {
    await db
      .prepare(
        `INSERT INTO app_logs (created_at, level, code, status, method, path, client_id, message_id, ip, detail)
         VALUES (unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(e.level, e.code, e.status ?? null, e.method ?? null, e.path ?? null, e.client_id ?? null, e.message_id ?? null, e.ip ?? null, e.detail ?? null)
      .run();
  } catch {
    console.error(JSON.stringify({ error_code: "log_write_failed" }));
  }
}

/** The limiter key: the IPv4 address, or the /64 of an IPv6 one (one host usually owns a whole /64). */
function limitKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Logs an error response: 5xx error, 401/403/429 warn, other 4xx info. Warn and info are capped per IP. */
export async function logRequestError(env: Env, req: Request, error: HttpError, clientId?: string): Promise<void> {
  try {
    const path = new URL(req.url).pathname;
    // Scanner noise: unknown paths outside the API.
    if (error.status === 404 && !path.startsWith("/v1/") && !path.startsWith("/admin/api/")) return;
    const level = error.status >= 500 ? "error" : [401, 403, 429].includes(error.status) ? "warn" : "info";
    const ip = req.headers.get("CF-Connecting-IP") ?? undefined;
    if (level !== "error" && ip && !(await env.LOG_RATE_LIMITER.limit({ key: limitKey(ip) })).success) return;
    const messageId = typeof error.extra.id === "string" ? error.extra.id : undefined;
    await log(env.DB, { level, code: error.code, status: error.status, method: req.method, path, client_id: clientId, message_id: messageId, ip });
  } catch {
    console.error(JSON.stringify({ error_code: "log_write_failed" }));
  }
}

/** Deletes rows older than 30 days, in batches so one statement never holds the write lock for long. */
export async function purgeLogs(db: D1Database): Promise<void> {
  for (;;) {
    const { meta } = await db
      .prepare("DELETE FROM app_logs WHERE id IN (SELECT id FROM app_logs WHERE created_at < unixepoch() - ? LIMIT ?)")
      .bind(RETENTION_S, PURGE_BATCH)
      .run();
    if (meta.changes < PURGE_BATCH) return;
  }
}

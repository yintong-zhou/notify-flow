import { invalid } from "../security/validation";
import { ABANDONED_AFTER_S } from "../services/email-service";
import type { DeliveryStatus } from "../types";

const STATUSES: DeliveryStatus[] = ["accepted", "queued", "processing", "retrying", "submitted", "failed"];
// window → [span, bucket] in seconds; buckets are UTC hours or days.
const WINDOWS: Record<string, [number, number]> = { "24h": [86400, 3600], "7d": [7 * 86400, 86400], "30d": [30 * 86400, 86400] };
const FILTERS = ["id", "recipient", "client_id", "template", "status", "error_code"] as const;
const PAGE = 50;
const CURSOR_RE = /^(\d+):(msg_[0-9a-f-]{36})$/;

export async function stats(req: Request, env: Env): Promise<Response> {
  const window = new URL(req.url).searchParams.get("window") ?? "24h";
  if (!Object.hasOwn(WINDOWS, window)) invalid("window must be one of 24h, 7d, 30d");
  const [span, bucket] = WINDOWS[window];
  // ponytail: GROUP BY over up to 30 days of raw rows. Past a few 100k deliveries a month, add a daily aggregate table the cron fills.
  const [byStatus, errors, series] = await env.DB.batch([
    env.DB.prepare(
      `SELECT status, COUNT(*) AS count,
         SUM(status = 'processing' AND COALESCE(claimed_at, created_at) < unixepoch() - ?) AS stalled
       FROM email_deliveries WHERE created_at >= unixepoch() - ? GROUP BY status`,
    ).bind(ABANDONED_AFTER_S, span),
    env.DB.prepare(
      `SELECT d.error_code, d.client_id, c.name AS client_name, d.template, COUNT(*) AS count
       FROM email_deliveries d JOIN clients c ON c.id = d.client_id
       WHERE d.created_at >= unixepoch() - ? AND d.error_code IS NOT NULL
       GROUP BY d.error_code, d.client_id, d.template ORDER BY count DESC LIMIT 20`,
    ).bind(span),
    env.DB.prepare(
      `SELECT created_at - created_at % ? AS bucket, status, COUNT(*) AS count
       FROM email_deliveries WHERE created_at >= unixepoch() - ? GROUP BY bucket, status ORDER BY bucket`,
    ).bind(bucket, span),
  ]);
  const byStatusCounts: Record<string, number> = Object.fromEntries([...STATUSES, "stalled"].map((s) => [s, 0]));
  for (const row of byStatus.results as { status: string; count: number; stalled: number }[]) {
    byStatusCounts[row.status] = row.count;
    byStatusCounts.stalled += row.stalled;
  }
  return Response.json({ window, by_status: byStatusCounts, errors: errors.results, series: series.results });
}

export async function deliveries(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const where: string[] = [];
  const binds: (string | number)[] = [];
  for (const field of FILTERS) {
    const value = params.get(field);
    if (!value) continue;
    if (field === "status" && !(STATUSES as string[]).includes(value)) invalid(`status must be one of ${STATUSES.join(", ")}`);
    where.push(`d.${field} = ?`); // field comes from FILTERS, never from the request
    binds.push(field === "recipient" ? value.toLowerCase() : value);
  }
  const before = params.get("before");
  if (before) {
    const cursor = CURSOR_RE.exec(before);
    if (!cursor) invalid("before must be a cursor returned as next");
    where.push("(d.created_at < ? OR (d.created_at = ? AND d.id < ?))");
    binds.push(Number(cursor[1]), Number(cursor[1]), cursor[2]);
  }
  const { results } = await env.DB.prepare(
    `SELECT d.*, c.name AS client_name FROM email_deliveries d JOIN clients c ON c.id = d.client_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
  )
    .bind(...binds, PAGE + 1)
    .all<{ id: string; created_at: number }>();
  const page = results.slice(0, PAGE);
  const last = page.at(-1);
  return Response.json({ deliveries: page, next: results.length > PAGE && last ? `${last.created_at}:${last.id}` : null });
}

const LEVELS = ["error", "warn", "info"];
const LOG_FILTERS = ["level", "code", "client_id", "ip", "message_id"] as const;

export async function logs(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const where: string[] = [];
  const binds: (string | number)[] = [];
  for (const field of LOG_FILTERS) {
    const value = params.get(field);
    if (!value) continue;
    if (field === "level" && !LEVELS.includes(value)) invalid("level must be one of error, warn, info");
    where.push(`l.${field} = ?`); // field comes from LOG_FILTERS, never from the request
    binds.push(value);
  }
  const before = params.get("before");
  if (before) {
    if (!/^[1-9]\d{0,15}$/.test(before)) invalid("before must be a cursor returned as next");
    where.push("l.id < ?");
    binds.push(Number(before));
  }
  const { results } = await env.DB.prepare(
    `SELECT l.*, c.name AS client_name FROM app_logs l LEFT JOIN clients c ON c.id = l.client_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY l.id DESC LIMIT ?`,
  )
    .bind(...binds, PAGE + 1)
    .all<{ id: number }>();
  const page = results.slice(0, PAGE);
  return Response.json({ logs: page, next: results.length > PAGE ? page[PAGE - 1].id : null });
}

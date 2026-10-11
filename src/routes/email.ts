import { parseIdempotencyKey, parseSendRequest, readJson } from "../security/validation";
import { enqueueTemplatedEmail, findDelivery, sendTemplatedEmail } from "../services/email-service";
import type { SendMailFn } from "../smtp/smtp-client";
import { HttpError } from "../types";

export async function sendEmail(
  req: Request,
  env: Env,
  clientId: string,
  send: SendMailFn,
  ctx?: ExecutionContext,
): Promise<Response> {
  const idempotencyKey = parseIdempotencyKey(req);
  const request = parseSendRequest(await readJson(req));
  const requestId = req.headers.get("cf-ray") ?? crypto.randomUUID();
  // RFC 7240: preference names are case-insensitive, and Prefer may list several.
  if (/\brespond-async\b/i.test(req.headers.get("Prefer") ?? "")) {
    const queued = enqueueTemplatedEmail(env, clientId, request, { idempotencyKey, requestId });
    // As below: a caller disconnecting between the INSERT and the enqueue must not leave a queued row with no message.
    ctx?.waitUntil(queued.catch(() => {}));
    return Response.json(await queued, { status: 202, headers: { "Preference-Applied": "respond-async" } });
  }
  const result = sendTemplatedEmail(env, clientId, request, { idempotencyKey, requestId }, send);
  // Keep the send (and its status UPDATE) running if the caller disconnects before it finishes.
  ctx?.waitUntil(result.catch(() => {}));
  return Response.json(await result);
}

export async function getEmail(env: Env, clientId: string, id: string): Promise<Response> {
  // Another client's id answers the same 404 as an unknown one, so existence never leaks.
  const delivery = await findDelivery(env.DB, clientId, "id", id);
  if (!delivery) throw new HttpError(404, "not_found", "Email not found");
  return Response.json(delivery);
}

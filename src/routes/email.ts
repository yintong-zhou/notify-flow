import { parseIdempotencyKey, parseSendRequest, readJson } from "../security/validation";
import { sendTemplatedEmail } from "../services/email-service";
import type { SendMailFn } from "../smtp/smtp-client";

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
  const result = sendTemplatedEmail(env, clientId, request, { idempotencyKey, requestId }, send);
  // Keep the send (and its status UPDATE) running if the caller disconnects before it finishes.
  ctx?.waitUntil(result.catch(() => {}));
  return Response.json(await result);
}

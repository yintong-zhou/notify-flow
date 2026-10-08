import { parseIdempotencyKey, parseSendRequest, readJson } from "../security/validation";
import { sendTemplatedEmail } from "../services/email-service";
import type { SendMailFn } from "../smtp/smtp-client";

export async function sendEmail(req: Request, env: Env, clientId: string, send: SendMailFn): Promise<Response> {
  const idempotencyKey = parseIdempotencyKey(req);
  const request = parseSendRequest(await readJson(req));
  const requestId = req.headers.get("cf-ray") ?? crypto.randomUUID();
  return Response.json(await sendTemplatedEmail(env, clientId, request, { idempotencyKey, requestId }, send));
}

import { parseNotification, readJson } from "../security/validation";
import type { SendMailFn } from "../smtp/smtp-client";
import { resolveEvent } from "../templates/events";
import { dispatch } from "./email";

/** Resolves the event to a template name, then behaves exactly like /v1/email/send for that template. */
export async function sendNotification(
  req: Request,
  env: Env,
  clientId: string,
  send: SendMailFn,
  ctx?: ExecutionContext,
): Promise<Response> {
  const { event, ...target } = parseNotification(await readJson(req));
  const template = await resolveEvent(env.DB, clientId, event);
  return dispatch(req, env, clientId, { template, ...target }, send, ctx);
}

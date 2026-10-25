import { parseIdempotencyKey, readJson } from "../security/validation";
import { HttpError } from "../types";
import { pushConfigured, vapidKeys } from "./crypto";
import { sendPush } from "./sender";
import { removeSubscriptions, upsertSubscription } from "./subscriptions";
import { parsePushRequest, parseSubscription, parseUnsubscribe } from "./validation";

export type PushFetch = (url: string, init: RequestInit) => Promise<Response>;

type Handler = (req: Request, env: Env, clientId: string, fetchPush: PushFetch, ctx?: ExecutionContext) => Promise<Response>;

/** Every gated route runs these two checks, in this order. */
const withGates =
  (handler: Handler): Handler =>
  async (req, env, clientId, ...rest) => {
    if (!pushConfigured(env)) throw new HttpError(503, "push_not_configured", "Web Push is not configured on this service");
    const row = await env.DB.prepare("SELECT push_enabled FROM clients WHERE id = ?").bind(clientId).first<{ push_enabled: number }>();
    if (!row?.push_enabled) throw new HttpError(403, "push_disabled", "Web Push is not enabled for this client");
    return handler(req, env, clientId, ...rest);
  };

const publicKey: Handler = async (_req, env) => Response.json({ public_key: vapidKeys(env)!.publicKey });

const putSubscription: Handler = async (req, env, clientId) => {
  const { userId, sub } = parseSubscription(await readJson(req));
  await upsertSubscription(env.DB, clientId, userId, sub);
  return new Response(null, { status: 204 });
};

// Not gated: erasing a user's devices must work even with push off, for example on account deletion.
const deleteSubscriptions: Handler = async (req, env, clientId) => {
  await removeSubscriptions(env.DB, clientId, parseUnsubscribe(await readJson(req)));
  return new Response(null, { status: 204 });
};

const send: Handler = async (req, env, clientId, fetchPush, ctx) => {
  const idempotencyKey = parseIdempotencyKey(req); // before the body, so a bad key is rejected without reading it
  const request = parsePushRequest(await readJson(req));
  const requestId = req.headers.get("cf-ray") ?? crypto.randomUUID();
  const result = sendPush(env, clientId, request, { idempotencyKey, requestId }, fetchPush);
  // Keep the send (and its status UPDATE) running if the caller disconnects before it finishes.
  ctx?.waitUntil(result.catch(() => {}));
  return Response.json(await result);
};

const ROUTES: Record<string, Record<string, Handler>> = {
  "public-key": { GET: withGates(publicKey) },
  send: { POST: withGates(send) },
  subscriptions: { PUT: withGates(putSubscription), DELETE: deleteSubscriptions },
};

/** `/v1/push/<route>`. Unknown routes and methods are answered before the push gates. */
export async function handlePush(req: Request, env: Env, clientId: string, route: string, fetchPush: PushFetch, ctx?: ExecutionContext): Promise<Response> {
  // Object.hasOwn: "constructor" or "toString" must not resolve through the prototype.
  const methods = Object.hasOwn(ROUTES, route) ? ROUTES[route] : undefined;
  if (!methods) throw new HttpError(404, "not_found", "Route not found");
  if (!Object.hasOwn(methods, req.method)) {
    throw new HttpError(405, "method_not_allowed", `Allowed methods: ${Object.keys(methods).join(", ")}`);
  }
  return methods[req.method](req, env, clientId, fetchPush, ctx);
}

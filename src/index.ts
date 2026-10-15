import { purgeSessions } from "./admin/auth";
import { handleAdmin } from "./admin/routes";
import { getEmail, sendEmail } from "./routes/email";
import { deleteEvent, getEvent, listEvents, putEvent } from "./routes/events";
import { sendNotification } from "./routes/notifications";
import { health } from "./routes/health";
import { deleteTemplate, getTemplate, listTemplates, putTemplate } from "./routes/templates";
import { authenticate } from "./security/auth";
import { checkClientLimit, checkIpLimit } from "./security/rate-limit";
import { purgeDeliveries, type QueuedEmail } from "./services/email-service";
import { logRequestError, purgeLogs } from "./services/logger";
import { handleQueue } from "./services/queue-consumer";
import { sendMail, type SendMailFn } from "./smtp/smtp-client";
import { HttpError } from "./types";

const TEMPLATE_PATH = /^\/v1\/templates\/([^/]+)\/([^/]+)$/;
const EMAIL_PATH = /^\/v1\/email\/(msg_[0-9a-f-]{36})$/;
const EVENT_PATH = /^\/v1\/events\/([^/]+)$/;

export async function handle(
  req: Request,
  env: Env,
  send: SendMailFn = sendMail,
  ctx?: ExecutionContext,
): Promise<Response> {
  let clientId: string | undefined;
  try {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") {
      allow(req, "GET");
      return health();
    }
    if (pathname.startsWith("/admin/api/")) return await handleAdmin(req, env, pathname.slice("/admin/api/".length));
    if (!pathname.startsWith("/v1/")) throw new HttpError(404, "not_found", "Route not found");

    await checkIpLimit(env, req);
    clientId = await authenticate(req, env);
    await checkClientLimit(env, clientId);

    if (pathname === "/v1/email/send") {
      allow(req, "POST");
      return await sendEmail(req, env, clientId, send, ctx);
    }
    if (pathname === "/v1/notifications") {
      allow(req, "POST");
      return await sendNotification(req, env, clientId, send, ctx);
    }
    const email = EMAIL_PATH.exec(pathname);
    if (email) {
      allow(req, "GET");
      return await getEmail(env, clientId, email[1]);
    }
    if (pathname === "/v1/events") {
      allow(req, "GET");
      return await listEvents(env, clientId);
    }
    const eventMatch = EVENT_PATH.exec(pathname);
    if (eventMatch) {
      allow(req, "GET", "PUT", "DELETE");
      const event = eventMatch[1];
      if (req.method === "GET") return await getEvent(env, clientId, event);
      if (req.method === "PUT") return await putEvent(req, env, clientId, event);
      return await deleteEvent(env, clientId, event);
    }
    if (pathname === "/v1/templates") {
      allow(req, "GET");
      return await listTemplates(env, clientId);
    }
    const match = TEMPLATE_PATH.exec(pathname);
    if (match) {
      allow(req, "GET", "PUT", "DELETE");
      const [, name, locale] = match;
      if (req.method === "GET") return await getTemplate(env, clientId, name, locale);
      if (req.method === "PUT") return await putTemplate(req, env, clientId, name, locale);
      return await deleteTemplate(env, clientId, name, locale);
    }
    throw new HttpError(404, "not_found", "Route not found");
  } catch (e) {
    return await errorResponse(req, env, e, clientId, ctx);
  }
}

function allow(req: Request, ...methods: string[]): void {
  if (!methods.includes(req.method)) {
    throw new HttpError(405, "method_not_allowed", `Allowed methods: ${methods.join(", ")}`);
  }
}

async function errorResponse(req: Request, env: Env, e: unknown, clientId?: string, ctx?: ExecutionContext): Promise<Response> {
  // No e.message for unexpected errors: it could carry request data, and logs must never hold it.
  const error = e instanceof HttpError ? e : new HttpError(500, "internal_error", "Internal error");
  const logged = logRequestError(env, req, error, clientId);
  if (ctx) ctx.waitUntil(logged);
  else await logged;
  return Response.json({ error: { code: error.code, message: error.message }, ...error.extra }, { status: error.status });
}

export default {
  fetch: (req, env, ctx) => handle(req, env, sendMail, ctx),
  scheduled: (_controller, env, ctx) => ctx.waitUntil(Promise.all([purgeDeliveries(env.DB), purgeSessions(env.DB), purgeLogs(env.DB)])),
  queue: (batch, env) => handleQueue(batch, env, sendMail),
} satisfies ExportedHandler<Env, QueuedEmail>;

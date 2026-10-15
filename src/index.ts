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
  try {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") {
      allow(req, "GET");
      return health();
    }
    if (pathname.startsWith("/admin/api/")) return await handleAdmin(req, env, pathname.slice("/admin/api/".length));
    if (!pathname.startsWith("/v1/")) throw new HttpError(404, "not_found", "Route not found");

    await checkIpLimit(env, req);
    const clientId = await authenticate(req, env);
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
    return errorResponse(e);
  }
}

function allow(req: Request, ...methods: string[]): void {
  if (!methods.includes(req.method)) {
    throw new HttpError(405, "method_not_allowed", `Allowed methods: ${methods.join(", ")}`);
  }
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    return Response.json({ error: { code: e.code, message: e.message }, ...e.extra }, { status: e.status });
  }
  // No e.message: an unexpected error could carry request data, and logs must never hold it.
  console.error(JSON.stringify({ error_code: "internal_error" }));
  return Response.json({ error: { code: "internal_error", message: "Internal error" } }, { status: 500 });
}

export default {
  fetch: (req, env, ctx) => handle(req, env, sendMail, ctx),
  scheduled: (_controller, env, ctx) => ctx.waitUntil(Promise.all([purgeDeliveries(env.DB), purgeSessions(env.DB)])),
  queue: (batch, env) => handleQueue(batch, env, sendMail),
} satisfies ExportedHandler<Env, QueuedEmail>;

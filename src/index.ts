import { sendEmail } from "./routes/email";
import { health } from "./routes/health";
import { deleteTemplate, getTemplate, listTemplates, putTemplate } from "./routes/templates";
import { authenticate } from "./security/auth";
import { checkClientLimit, checkIpLimit } from "./security/rate-limit";
import { purgeDeliveries } from "./services/email-service";
import { sendMail, type SendMailFn } from "./smtp/smtp-client";
import { HttpError } from "./types";

const TEMPLATE_PATH = /^\/v1\/templates\/([^/]+)\/([^/]+)$/;

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
    if (!pathname.startsWith("/v1/")) throw new HttpError(404, "not_found", "Route not found");

    await checkIpLimit(env, req);
    const clientId = await authenticate(req, env);
    await checkClientLimit(env, clientId);

    if (pathname === "/v1/email/send") {
      allow(req, "POST");
      return await sendEmail(req, env, clientId, send, ctx);
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
  scheduled: (_controller, env, ctx) => ctx.waitUntil(purgeDeliveries(env.DB)),
} satisfies ExportedHandler<Env>;

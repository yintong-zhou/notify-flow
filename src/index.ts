import { health } from "./routes/health";
import { deleteTemplate, getTemplate, listTemplates, putTemplate } from "./routes/templates";
import { authenticate } from "./security/auth";
import { checkClientLimit } from "./security/rate-limit";
import { sendMail, type SendMailFn } from "./smtp/smtp-client";
import { HttpError } from "./types";

const TEMPLATE_PATH = /^\/v1\/templates\/([^/]+)\/([^/]+)$/;

export async function handle(req: Request, env: Env, send: SendMailFn = sendMail): Promise<Response> {
  try {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") {
      allow(req, "GET");
      return health();
    }
    if (!pathname.startsWith("/v1/")) throw new HttpError(404, "not_found", "Route not found");

    const clientId = await authenticate(req, env);
    await checkClientLimit(env, clientId);

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
  console.error(JSON.stringify({ error_code: "internal_error", message: e instanceof Error ? e.message : String(e) }));
  return Response.json({ error: { code: "internal_error", message: "Internal error" } }, { status: 500 });
}

export default { fetch: (req, env) => handle(req, env) } satisfies ExportedHandler<Env>;

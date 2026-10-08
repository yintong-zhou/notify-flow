import { health } from "./routes/health";
import { HttpError } from "./types";

export async function handle(req: Request, env: Env): Promise<Response> {
  try {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") {
      allow(req, "GET");
      return health();
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

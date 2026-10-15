import { checkAdminLimit, checkIpLimit } from "../security/rate-limit";
import { EMAIL_RE, invalid, readJson } from "../security/validation";
import { HttpError } from "../types";
import { CLEARED_COOKIE, createSession, hashPassword, requireSession, sameSecret, sessionHash, verifyPassword } from "./auth";

export type Handler = (req: Request, env: Env) => Promise<Response>;

const invalidCredentials = () => new HttpError(401, "invalid_credentials", "Invalid email or password");
const adminRow = (db: D1Database) =>
  db.prepare("SELECT email, password_hash FROM admin_user WHERE id = 1").first<{ email: string; password_hash: string }>();

// With SameSite=Strict this is the CSRF guard: a cross-site form cannot send JSON without a CORS preflight.
function requireJson(req: Request): void {
  if (!req.headers.get("Content-Type")?.startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
}

function parseEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !EMAIL_RE.test(value)) invalid("email must be a valid email address");
  return value.toLowerCase();
}

function parseNewPassword(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 256) invalid(`${field} must be 12-256 characters`);
  return value;
}

async function startSession(env: Env, status: number, email: string): Promise<Response> {
  return Response.json({ email }, { status, headers: { "Set-Cookie": await createSession(env.DB) } });
}

export const withSession =
  (handler: Handler): Handler =>
  async (req, env) => {
    await requireSession(req, env.DB);
    return handler(req, env);
  };

async function me(req: Request, env: Env): Promise<Response> {
  const admin = await adminRow(env.DB);
  if (!admin) return Response.json({ registered: false, logged_in: false });
  if (!(await sessionHash(req, env.DB))) return Response.json({ registered: true, logged_in: false });
  return Response.json({ registered: true, logged_in: true, email: admin.email });
}

async function setup(req: Request, env: Env): Promise<Response> {
  requireJson(req);
  await checkAdminLimit(env, req);
  const body = await readJson(req);
  // Without ADMIN_SETUP_TOKEN, setup stays closed instead of open to anyone.
  if (!env.ADMIN_SETUP_TOKEN || typeof body.setup_token !== "string" || !(await sameSecret(body.setup_token, env.ADMIN_SETUP_TOKEN))) {
    throw new HttpError(403, "invalid_setup_token", "Invalid setup token");
  }
  const email = parseEmail(body.email);
  const hash = await hashPassword(parseNewPassword(body.password, "password"));
  // id is always 1 (CHECK in the schema): a second or concurrent setup hits the primary key and changes nothing.
  const { meta } = await env.DB.prepare(
    "INSERT INTO admin_user (id, email, password_hash, created_at) VALUES (1, ?, ?, unixepoch()) ON CONFLICT DO NOTHING",
  )
    .bind(email, hash)
    .run();
  if (meta.changes === 0) throw new HttpError(409, "already_registered", "The admin account already exists");
  return startSession(env, 201, email);
}

async function login(req: Request, env: Env): Promise<Response> {
  requireJson(req);
  await checkAdminLimit(env, req);
  const { email, password } = await readJson(req);
  const admin = await adminRow(env.DB);
  if (!admin || typeof email !== "string" || typeof password !== "string" || password.length > 256) throw invalidCredentials();
  // Password first, always: the response time does not reveal whether the email matched.
  if (!(await verifyPassword(password, admin.password_hash)) || admin.email !== email.toLowerCase()) throw invalidCredentials();
  return startSession(env, 200, admin.email);
}

async function logout(req: Request, env: Env): Promise<Response> {
  requireJson(req);
  const hash = await sessionHash(req, env.DB);
  if (hash) await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(hash).run();
  return new Response(null, { status: 204, headers: { "Set-Cookie": CLEARED_COOKIE } });
}

async function changePassword(req: Request, env: Env): Promise<Response> {
  requireJson(req);
  await checkAdminLimit(env, req);
  const current = await requireSession(req, env.DB);
  const body = await readJson(req);
  const next = parseNewPassword(body.new, "new");
  const admin = (await adminRow(env.DB))!; // a session exists only after setup
  if (typeof body.current !== "string" || body.current.length > 256 || !(await verifyPassword(body.current, admin.password_hash))) {
    throw invalidCredentials();
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE admin_user SET password_hash = ? WHERE id = 1").bind(await hashPassword(next)),
    env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash != ?").bind(current),
  ]);
  return new Response(null, { status: 204 });
}

const ROUTES: Record<string, Record<string, Handler>> = {
  me: { GET: me },
  setup: { POST: setup },
  login: { POST: login },
  logout: { POST: logout },
  password: { POST: changePassword },
};

/** `/admin/api/<route>`: the dashboard's JSON API. A session cookie authenticates it, never an API key. */
export async function handleAdmin(req: Request, env: Env, route: string): Promise<Response> {
  await checkIpLimit(env, req);
  // Object.hasOwn: "constructor" or "toString" must not resolve through the prototype.
  const methods = Object.hasOwn(ROUTES, route) ? ROUTES[route] : undefined;
  if (!methods) throw new HttpError(404, "not_found", "Route not found");
  if (!Object.hasOwn(methods, req.method)) {
    throw new HttpError(405, "method_not_allowed", `Allowed methods: ${Object.keys(methods).join(", ")}`);
  }
  return methods[req.method](req, env);
}

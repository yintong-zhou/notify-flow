# Admin Dashboard Plan — Part 2: Task 1 tests

[← Part 1](2026-10-15-admin-dashboard.md) · [Part 3: Task 1 code →](2026-10-15-admin-dashboard-part3.md)

## `test/helpers.ts` (append)

`call()` sends no `Content-Type`, but admin routes need it, so they get their own helper. `env` and `handle` are already imported in this file.

```ts
export const SETUP_TOKEN = "test-setup-token";

export interface AdminInit {
  method?: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}

/** Calls /admin/api/<path>. A body means POST with Content-Type: application/json. */
export function adminCall(path: string, init: AdminInit = {}, testEnv: Env = env): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.cookie) headers.Cookie = init.cookie;
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return handle(new Request(`https://notify.test/admin/api/${path}`, { method, headers: { ...headers, ...init.headers }, body }), testEnv);
}

/** "nf_admin=<token>" from a response's Set-Cookie, ready for a Cookie header. */
export const sessionCookie = (res: Response): string => res.headers.get("Set-Cookie")!.split(";")[0];

/** Registers the admin (admin@example.com / "correct horse battery") and returns its session cookie. */
export async function setupAdmin(): Promise<string> {
  const res = await adminCall("setup", {
    body: { setup_token: SETUP_TOKEN, email: "admin@example.com", password: "correct horse battery" },
  });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status}`);
  return sessionCookie(res);
}
```

## `test/admin.test.ts`

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeSessions } from "../src/admin/auth";
import { sha256Hex } from "../src/security/auth";
import { adminCall, call, createClient, sessionCookie, SETUP_TOKEN } from "./helpers";

const EMAIL = "admin@example.com";
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "another long password";
const setup = (body: Record<string, unknown> = {}, testEnv?: Env) =>
  adminCall("setup", { body: { setup_token: SETUP_TOKEN, email: EMAIL, password: PASSWORD, ...body } }, testEnv);
const login = (email = EMAIL, password = PASSWORD) => adminCall("login", { body: { email, password } });
const code = async (res: Response) => (await res.json<any>()).error.code;
const loggedIn = async (cookie?: string) => (await (await adminCall("me", { cookie })).json<any>()).logged_in;
const count = (table: string) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n");

describe("first-run setup", () => {
  it("reports an unregistered dashboard", async () => {
    expect(await (await adminCall("me")).json()).toEqual({ registered: false, logged_in: false });
  });

  it("rejects a wrong, missing or unconfigured setup token", async () => {
    expect(await code(await setup({ setup_token: "wrong" }))).toBe("invalid_setup_token");
    expect((await setup({ setup_token: undefined })).status).toBe(403);
    expect((await setup({}, { ...env, ADMIN_SETUP_TOKEN: "" })).status).toBe(403);
    expect(await count("admin_user")).toBe(0);
  });

  it("creates the only admin once and logs it in", async () => {
    const res = await setup();
    expect(res.status).toBe(201);
    expect(await (await adminCall("me", { cookie: sessionCookie(res) })).json()).toEqual({ registered: true, logged_in: true, email: EMAIL });
    const again = await setup({ email: "other@example.com" });
    expect(again.status).toBe(409);
    expect(await code(again)).toBe("already_registered");
  });

  it("lets only one of two concurrent setups win", async () => {
    const statuses = (await Promise.all([setup(), setup({ email: "other@example.com" })])).map((r) => r.status);
    expect(statuses.sort()).toEqual([201, 409]);
  });

  it("stores a PBKDF2 hash, never the password", async () => {
    await setup({ email: "Admin@Example.com" });
    const row = await env.DB.prepare("SELECT email, password_hash FROM admin_user").first<any>();
    expect(row.email).toBe(EMAIL);
    expect(row.password_hash).toMatch(/^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  });

  it("validates the email and the password length", async () => {
    expect(await code(await setup({ email: "not-an-email" }))).toBe("validation_error");
    expect(await code(await setup({ password: "short" }))).toBe("validation_error");
    expect(await code(await setup({ password: "x".repeat(257) }))).toBe("validation_error");
  });
});

describe("login and sessions", () => {
  it("sets a hardened session cookie and stores only its hash", async () => {
    await setup();
    const res = await login();
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^nf_admin=[0-9a-f]{64}; /);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/admin", "Max-Age=604800"]) expect(cookie).toContain(attr);
    const token = sessionCookie(res).split("=")[1];
    const hashes = (await env.DB.prepare("SELECT token_hash FROM admin_sessions").all<any>()).results.map((r) => r.token_hash);
    expect(hashes).not.toContain(token);
    expect(hashes).toContain(await sha256Hex(token));
  });

  it("answers the same 401 for a wrong password and an unknown email, and ignores email case", async () => {
    await setup();
    const a = await login(EMAIL, "wrong password!!");
    const b = await login("nobody@example.com", PASSWORD);
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(await a.json()).toEqual(await b.json());
    expect((await login(EMAIL.toUpperCase())).status).toBe(200);
  });

  it("finds the session among other cookies", async () => {
    const cookie = sessionCookie(await setup());
    expect(await loggedIn(`theme=dark; ${cookie}; lang=it`)).toBe(true);
  });

  it("logs out, and rejects unknown and expired sessions", async () => {
    const cookie = sessionCookie(await setup());
    const out = await adminCall("logout", { body: {}, cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await loggedIn(cookie)).toBe(false);
    expect(await loggedIn(`nf_admin=${"0".repeat(64)}`)).toBe(false);
    const expired = sessionCookie(await login());
    await env.DB.prepare("UPDATE admin_sessions SET expires_at = unixepoch() - 1").run();
    expect(await loggedIn(expired)).toBe(false);
    await purgeSessions(env.DB);
    expect(await count("admin_sessions")).toBe(0);
  });

  it("rejects state-changing requests that are not JSON (CSRF)", async () => {
    await setup();
    const res = await adminCall("login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(415);
    expect(await code(res)).toBe("unsupported_media_type");
  });

  it("rate limits login per IP", async () => {
    await setup();
    const attempt = () =>
      adminCall("login", { body: { email: EMAIL, password: "wrong password!!" }, headers: { "CF-Connecting-IP": "203.0.113.9" } });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);
    expect(await code(await attempt())).toBe("rate_limited");
  });

  it("answers 404 for unknown routes and 405 for wrong methods", async () => {
    expect((await adminCall("nope")).status).toBe(404);
    expect((await adminCall("constructor")).status).toBe(404);
    expect((await adminCall("login")).status).toBe(405);
    expect((await adminCall("me", { method: "toString" })).status).toBe(405);
  });
});

describe("password change", () => {
  it("requires a session", async () => {
    await setup();
    expect(await code(await adminCall("password", { body: { current: PASSWORD, new: NEW_PASSWORD } }))).toBe("unauthorized");
  });

  it("checks the current password and logs out every other session", async () => {
    const mine = sessionCookie(await setup());
    const other = sessionCookie(await login());
    const change = (current: string, next: string) => adminCall("password", { body: { current, new: next }, cookie: mine });
    expect(await code(await change("not the password", NEW_PASSWORD))).toBe("invalid_credentials");
    expect(await code(await change(PASSWORD, "short"))).toBe("validation_error");
    expect((await change(PASSWORD, NEW_PASSWORD)).status).toBe(204);
    expect(await loggedIn(mine)).toBe(true);
    expect(await loggedIn(other)).toBe(false);
    expect((await login()).status).toBe(401);
    expect((await login(EMAIL, NEW_PASSWORD)).status).toBe(200);
  });
});

describe("isolation from API-key auth", () => {
  it("an API key never opens /admin/api and a session never opens /v1", async () => {
    const cookie = sessionCookie(await setup());
    const { key } = await createClient();
    expect(await loggedIn()).toBe(false);
    expect(await (await adminCall("me", { headers: { Authorization: `Bearer ${key}` } })).json()).toMatchObject({ logged_in: false });
    expect((await call("/v1/templates", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});
```

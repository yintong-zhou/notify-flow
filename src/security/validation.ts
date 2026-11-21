import { placeholders } from "../templates/renderer";
import { HttpError, isLocale, LOCALES, type Locale, type Template } from "../types";

export const MAX_BODY_BYTES = 256 * 1024;
export const NAME_RE = /^[a-z0-9-]{1,64}$/;
const VARIABLE_RE = /^[a-zA-Z0-9_]{1,64}$/;
const encoder = new TextEncoder();

export function invalid(message: string): never {
  throw new HttpError(400, "validation_error", message);
}

/** Reads the body, stopping as soon as it exceeds MAX_BODY_BYTES instead of buffering all of it first. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const tooLarge = () => new HttpError(413, "payload_too_large", "Body exceeds 256 KB");
  if (Number(req.headers.get("Content-Length")) > MAX_BODY_BYTES) throw tooLarge();
  const decoder = new TextDecoder();
  let raw = "";
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw tooLarge(); // leaving the loop cancels the stream
    raw += decoder.decode(chunk, { stream: true });
  }
  raw += decoder.decode();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) invalid("Body must be a JSON object");
  return body as Record<string, unknown>;
}

/**
 * The locales this deployment accepts: the comma-separated LOCALES var, or every supported locale when it is empty.
 * Unknown entries are ignored, so a list with no supported locale at all rejects every locale.
 */
export function enabledLocales(env: Pick<Env, "LOCALES">): readonly Locale[] {
  const listed = (env.LOCALES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return listed.length ? listed.filter(isLocale) : LOCALES;
}

export function parseLocale(raw: unknown, enabled: readonly Locale[], field = "locale"): Locale {
  if (!isLocale(raw) || !enabled.includes(raw)) invalid(`${field} must be one of ${enabled.join(", ")}`);
  return raw;
}

export function parseTemplateKey(name: string, locale: string, enabled: readonly Locale[]): { name: string; locale: Locale } {
  if (!NAME_RE.test(name)) invalid("name must match ^[a-z0-9-]{1,64}$");
  return { name, locale: parseLocale(locale, enabled) };
}

const EVENT_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

export function parseEvent(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 64 || !EVENT_RE.test(raw)) {
    invalid("event must be at most 64 characters matching ^[a-z0-9_]+(\\.[a-z0-9_]+)+$");
  }
  return raw;
}

export function parseEventRoute(body: Record<string, unknown>): { template: string } {
  const { template } = body;
  if (typeof template !== "string" || !NAME_RE.test(template)) invalid("template must match ^[a-z0-9-]{1,64}$");
  return { template };
}

export function parseTemplate(body: Record<string, unknown>): Template {
  const { subject, html, text, variables } = body;
  if (typeof subject !== "string" || subject.length < 1 || subject.length > 255 || /[\r\n]/.test(subject)) {
    invalid("subject must be 1-255 characters on a single line");
  }
  if (typeof html !== "string" || encoder.encode(html).byteLength > 100 * 1024) invalid("html must be a string of at most 100 KB");
  if (typeof text !== "string" || encoder.encode(text).byteLength > 50 * 1024) invalid("text must be a string of at most 50 KB");
  if (!Array.isArray(variables) || !variables.every((v) => typeof v === "string" && VARIABLE_RE.test(v))) {
    invalid("variables must be an array of names matching ^[a-zA-Z0-9_]{1,64}$");
  }
  const declared = new Set<string>(variables);
  const undeclared = new Set([subject, html, text].flatMap(placeholders).filter((p) => !declared.has(p)));
  if (undeclared.size) invalid(`undeclared placeholders: ${[...undeclared].join(", ")}`);
  return { subject, html, text, variables: [...declared] };
}

// Printable ASCII without <>()[]\,;:@" and space: no CR/LF, a single recipient, nothing that needs quoting.
const ATOM = "[\\w.!#$%&'*+/=?^`{|}~-]+";
export const EMAIL_RE = new RegExp(`^${ATOM}@${ATOM}\\.${ATOM}$`);

export interface SendRequest {
  template: string;
  to: string;
  locale: Locale;
  variables: Record<string, string>;
}

/** The recipient checks shared by /v1/email/send and /v1/notifications; `names` labels the fields in errors. */
function parseTarget(
  to: unknown,
  locale: unknown,
  variables: unknown,
  names: { to: string; locale: string; variables: string },
  enabled: readonly Locale[],
): { to: string; locale: Locale; variables: Record<string, string> } {
  if (typeof to !== "string" || to.length > 254 || !EMAIL_RE.test(to)) invalid(`${names.to} must be a single valid email address`);
  const parsedLocale = parseLocale(locale, enabled, names.locale);
  if (
    typeof variables !== "object" ||
    variables === null ||
    Array.isArray(variables) ||
    !Object.values(variables).every((v) => typeof v === "string")
  ) {
    invalid(`${names.variables} must be an object of strings`);
  }
  return { to: to.toLowerCase(), locale: parsedLocale, variables: variables as Record<string, string> };
}

export function parseSendRequest(body: Record<string, unknown>, enabled: readonly Locale[]): SendRequest {
  const { template } = body;
  if (typeof template !== "string" || !NAME_RE.test(template)) invalid("template must match ^[a-z0-9-]{1,64}$");
  const names = { to: "to", locale: "locale", variables: "variables" };
  return { template, ...parseTarget(body.to, body.locale ?? "en", body.variables, names, enabled) };
}

export interface NotificationRequest {
  event: string;
  to: string;
  locale: Locale;
  variables: Record<string, string>;
}

export function parseNotification(body: Record<string, unknown>, enabled: readonly Locale[]): NotificationRequest {
  const event = parseEvent(body.event);
  const { recipient } = body;
  if (typeof recipient !== "object" || recipient === null || Array.isArray(recipient)) invalid("recipient must be an object");
  const { email, locale } = recipient as Record<string, unknown>;
  const names = { to: "recipient.email", locale: "recipient.locale", variables: "data" };
  return { event, ...parseTarget(email, locale ?? "en", body.data, names, enabled) };
}

export function parseIdempotencyKey(req: Request): string | null {
  const key = req.headers.get("Idempotency-Key");
  if (key !== null && (key.length < 1 || key.length > 255)) invalid("Idempotency-Key must be 1-255 characters");
  return key;
}

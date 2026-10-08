import { placeholders } from "../templates/renderer";
import { HttpError, isLocale, type Locale, type Template } from "../types";

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

export function parseTemplateKey(name: string, locale: string): { name: string; locale: Locale } {
  if (!NAME_RE.test(name)) invalid("name must match ^[a-z0-9-]{1,64}$");
  if (!isLocale(locale)) invalid("locale must be one of it, en, pt-BR");
  return { name, locale };
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

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export interface SendRequest {
  template: string;
  to: string;
  locale: Locale;
  variables: Record<string, string>;
}

export function parseSendRequest(body: Record<string, unknown>): SendRequest {
  const { template, to, variables } = body;
  const locale = body.locale ?? "en";
  if (typeof template !== "string" || !NAME_RE.test(template)) invalid("template must match ^[a-z0-9-]{1,64}$");
  // \s covers CR/LF; the comma check keeps it to a single recipient.
  if (typeof to !== "string" || to.length > 254 || !EMAIL_RE.test(to)) invalid("to must be a single valid email address");
  if (!isLocale(locale)) invalid("locale must be one of it, en, pt-BR");
  if (
    typeof variables !== "object" ||
    variables === null ||
    Array.isArray(variables) ||
    !Object.values(variables).every((v) => typeof v === "string")
  ) {
    invalid("variables must be an object of strings");
  }
  return { template, to: to.toLowerCase(), locale, variables: variables as Record<string, string> };
}

export function parseIdempotencyKey(req: Request): string | null {
  const key = req.headers.get("Idempotency-Key");
  if (key !== null && (key.length < 1 || key.length > 255)) invalid("Idempotency-Key must be 1-255 characters");
  return key;
}

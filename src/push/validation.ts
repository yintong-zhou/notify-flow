import { invalid, NAME_RE } from "../security/validation";
import { HttpError, isLocale } from "../types";
import { b64url } from "./crypto";
import type { PushRequest } from "./sender";
import type { Subscription } from "./subscriptions";

// Hosts a push service may use. The endpoint is fetched server-side, so anything else is an SSRF risk.
const PUSH_HOSTS = ["fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"];
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function parseUserId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 128 || CONTROL_CHARS.test(raw)) {
    invalid("user_id must be 1-128 characters without control characters");
  }
  return raw;
}

function parseEndpoint(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048) invalid("subscription.endpoint must be a URL of at most 2048 characters");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid("subscription.endpoint must be a URL");
  }
  // URL normalizes the default HTTPS port away (`:443` becomes an empty `url.port`),
  // so inspect the original authority as well to enforce the no-explicit-port contract.
  const authority = raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] ?? "";
  if (url.protocol !== "https:" || url.port || /:\d+$/.test(authority) || url.username || url.password) {
    invalid("subscription.endpoint must be an https URL without port or credentials");
  }
  if (!PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new HttpError(400, "unsupported_push_service", "The endpoint is not a supported push service");
  }
  return raw;
}

/** `value` must be unpadded base64url decoding to `length` bytes, the first being `first` when given. */
function parseKey(value: unknown, field: string, length: number, first?: number): string {
  let bytes: Uint8Array | undefined;
  try {
    bytes = typeof value === "string" ? b64url.decode(value) : undefined;
  } catch {
    // falls through to the same error as a wrong length
  }
  if (!bytes || bytes.length !== length || (first !== undefined && bytes[0] !== first)) {
    invalid(`subscription.keys.${field} must be base64url of ${length} bytes${first === undefined ? "" : ` starting with 0x0${first}`}`);
  }
  return value as string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A browser's `PushSubscription.toJSON()` plus the caller's user id. */
export function parseSubscription(body: Record<string, unknown>): { userId: string; sub: Subscription } {
  const userId = parseUserId(body.user_id);
  const { subscription } = body;
  if (!isObject(subscription) || !isObject(subscription.keys)) invalid("subscription must be an object with endpoint and keys");
  const endpoint = parseEndpoint(subscription.endpoint);
  return {
    userId,
    sub: {
      endpoint,
      p256dh: parseKey(subscription.keys.p256dh, "p256dh", 65, 4),
      auth: parseKey(subscription.keys.auth, "auth", 16),
    },
  };
}

/** Exactly one of `endpoint` (one device) or `user_id` (all of a user's devices). */
export function parseUnsubscribe(body: Record<string, unknown>): { endpoint: string } | { userId: string } {
  if (body.endpoint !== undefined && body.user_id === undefined) {
    if (typeof body.endpoint !== "string" || !body.endpoint || body.endpoint.length > 2048) invalid("endpoint must be a string of at most 2048 characters");
    return { endpoint: body.endpoint };
  }
  if (body.user_id !== undefined && body.endpoint === undefined) return { userId: parseUserId(body.user_id) };
  return invalid("Send exactly one of endpoint or user_id");
}

const TAG_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** `url` is a path on the platform's own site (the service worker resolves it against its origin), never another site. */
function parseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 512 || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || CONTROL_CHARS.test(raw)) {
    invalid("url must be a path of 1-512 characters starting with a single /");
  }
  return raw;
}

function parseVariables(raw: unknown): Record<string, string> {
  // Short single-line values keep message text out of the request mechanically.
  if (!isObject(raw) || !Object.values(raw).every((v) => typeof v === "string" && v.length >= 1 && v.length <= 64 && !CONTROL_CHARS.test(v))) {
    invalid("variables must be an object of strings of 1-64 characters without control characters");
  }
  return raw as Record<string, string>;
}

export function parsePushRequest(body: Record<string, unknown>): PushRequest {
  const userId = parseUserId(body.user_id);
  const { template, url, tag } = body;
  if (typeof template !== "string" || !NAME_RE.test(template)) invalid("template must match ^[a-z0-9-]{1,64}$");
  const locale = body.locale ?? "en";
  if (!isLocale(locale)) invalid("locale must be one of it, en, pt-BR");
  const request: PushRequest = { userId, template, locale, variables: parseVariables(body.variables) };
  if (url !== undefined) request.url = parseUrl(url);
  if (tag !== undefined) {
    if (typeof tag !== "string" || !TAG_RE.test(tag)) invalid("tag must match ^[A-Za-z0-9_-]{1,32}$");
    request.tag = tag;
  }
  return request;
}

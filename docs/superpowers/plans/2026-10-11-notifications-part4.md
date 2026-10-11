# Notifications Plan — Part 4: Task 2 code and documentation

[← Part 3](2026-10-11-notifications-part3.md) · [Part 1](2026-10-11-notifications.md)

## Task 2 code

**`src/security/validation.ts`**: replace `parseSendRequest` with this. The `to`, locale and variables checks move into `parseTarget`, which `parseNotification` reuses with its own field names in the error messages.

```ts
/** The recipient checks shared by /v1/email/send and /v1/notifications; `names` labels the fields in errors. */
function parseTarget(
  to: unknown,
  locale: unknown,
  variables: unknown,
  names: { to: string; locale: string; variables: string },
): { to: string; locale: Locale; variables: Record<string, string> } {
  if (typeof to !== "string" || to.length > 254 || !EMAIL_RE.test(to)) invalid(`${names.to} must be a single valid email address`);
  if (!isLocale(locale)) invalid(`${names.locale} must be one of it, en, pt-BR`);
  if (
    typeof variables !== "object" ||
    variables === null ||
    Array.isArray(variables) ||
    !Object.values(variables).every((v) => typeof v === "string")
  ) {
    invalid(`${names.variables} must be an object of strings`);
  }
  return { to: to.toLowerCase(), locale, variables: variables as Record<string, string> };
}

export function parseSendRequest(body: Record<string, unknown>): SendRequest {
  const { template } = body;
  if (typeof template !== "string" || !NAME_RE.test(template)) invalid("template must match ^[a-z0-9-]{1,64}$");
  return { template, ...parseTarget(body.to, body.locale ?? "en", body.variables, { to: "to", locale: "locale", variables: "variables" }) };
}

export interface NotificationRequest {
  event: string;
  to: string;
  locale: Locale;
  variables: Record<string, string>;
}

export function parseNotification(body: Record<string, unknown>): NotificationRequest {
  const event = parseEvent(body.event);
  const { recipient } = body;
  if (typeof recipient !== "object" || recipient === null || Array.isArray(recipient)) invalid("recipient must be an object");
  const { email, locale } = recipient as Record<string, unknown>;
  const names = { to: "recipient.email", locale: "recipient.locale", variables: "data" };
  return { event, ...parseTarget(email, locale ?? "en", body.data, names) };
}
```

**`src/routes/email.ts`**:
- Rename the body of `sendEmail` to `dispatch`. It now receives the parsed `request` and parses the `Idempotency-Key` itself.
- Add `type SendRequest` to the validation import.

```ts
/** Sends now, or enqueues with `Prefer: respond-async`. Shared by /v1/email/send and /v1/notifications. */
export async function dispatch(
  req: Request,
  env: Env,
  clientId: string,
  request: SendRequest,
  send: SendMailFn,
  ctx?: ExecutionContext,
): Promise<Response> {
  const idempotencyKey = parseIdempotencyKey(req);
  const requestId = req.headers.get("cf-ray") ?? crypto.randomUUID();
  // ... the existing Prefer / 202 / waitUntil branch and the sync send, unchanged ...
}

export async function sendEmail(req: Request, env: Env, clientId: string, send: SendMailFn, ctx?: ExecutionContext): Promise<Response> {
  return dispatch(req, env, clientId, parseSendRequest(await readJson(req)), send, ctx);
}
```

**`src/routes/notifications.ts`** (new file):

```ts
import { parseNotification, readJson } from "../security/validation";
import type { SendMailFn } from "../smtp/smtp-client";
import { resolveEvent } from "../templates/events";
import { dispatch } from "./email";

/** Resolves the event to a template name, then behaves exactly like /v1/email/send for that template. */
export async function sendNotification(
  req: Request,
  env: Env,
  clientId: string,
  send: SendMailFn,
  ctx?: ExecutionContext,
): Promise<Response> {
  const { event, ...target } = parseNotification(await readJson(req));
  const template = await resolveEvent(env.DB, clientId, event);
  return dispatch(req, env, clientId, { template, ...target }, send, ctx);
}
```

**`src/index.ts`**: import `sendNotification` from `./routes/notifications`, then insert this after the `/v1/email/send` block:

```ts
    if (pathname === "/v1/notifications") {
      allow(req, "POST");
      return await sendNotification(req, env, clientId, send, ctx);
    }
```

---

### Task 3: Documentation

Every file stays under 200 lines; check with `wc -l`.

- [ ] **Step 1: Create `docs/web-app-integration-events.md`** (about 70 lines). Its sections:
  - **Title and when to use it:** the backend names what happened, and the template choice lives in notify-flow. It is otherwise identical to `/v1/email/send`.
  - **Request:** a `curl` call for `auth.password_reset`. `recipient.email` is required, `recipient.locale` is optional (default `en`), and `data` holds exactly the template's variables.
  - **Response:** the same as `/v1/email/send`: `200 submitted`, `202 queued` with `Prefer: respond-async`, `Idempotency-Key` replays, and `GET /v1/email/:id`. Note that `Idempotency-Key`s and the recipient limit are shared with `/v1/email/send`.
  - **Built-in events:** the 6 rows from the spec, with the variables each template needs (`welcome`/`password-changed`: `appName`, `name`; `verify-email`: `+ verifyUrl`; `password-reset`: `+ resetUrl`; `login-alert`: `+ device`, `ipAddress`, `time`; `generic-notification`: `appName`, `title`, `message`).
  - **Managing mappings:**
    - a `curl` call for `PUT /v1/events/auth.password_reset` with `{"template":"my-reset"}`;
    - `GET /v1/events` and `GET /v1/events/:event`;
    - `DELETE`, which restores the built-in. Built-ins themselves cannot be deleted (`404`);
    - `PUT` checks that the template exists;
    - deleting a template does not delete mappings that point to it.
  - **Errors:** `404 event_not_found`; `404 template_not_found` (on `PUT`, or on send when the mapped template is missing in the locale and in `en`); `400 validation_error`; `400 invalid_variables`.
  - **Link** back to `web-app-integration.md`.
- [ ] **Step 2: `docs/web-app-integration.md`.** Below the async link line, add: `To send by event instead of by template name (\`POST /v1/notifications\`), see [Event-based sending](web-app-integration-events.md).`
- [ ] **Step 3: `README.md`**, kept under 200 lines.
  - Replace the 6-bullet "Built-in templates" list with one line: `**Built-in templates:** \`welcome\`, \`verify-email\`, \`password-reset\`, \`password-changed\`, \`login-alert\`, \`generic-notification\`.`
  - After "Check a delivery", add:

```markdown
### Send an event

`POST /v1/notifications` takes `{ "event": "auth.password_reset", "recipient": { "email": "…", "locale": "it" }, "data": { … } }` and sends the template mapped to the event, with the same responses, `Prefer` and `Idempotency-Key` behavior as `/v1/email/send`. Built-in events: `user.welcome`, `auth.email_verification`, `auth.password_reset`, `auth.password_changed`, `auth.login_alert`, `notification.generic`. Remap them or add your own with `GET`/`PUT`/`DELETE /v1/events/:event` ([guide](docs/web-app-integration-events.md)).
```

  - Remove the `POST /v1/notifications` bullet from "Roadmap".
- [ ] **Step 4: `CLAUDE.md`.**
  - In "Docs", change the integration guide line to `(+ \`-flows.md\`, \`-async.md\`, \`-events.md\`)`.
  - In "Architecture", after the async line, add: `Events (\`POST /v1/notifications\`): \`routes/notifications.ts\` resolves the event to a template name (the client's \`event_routes\` row, then \`BUILTIN_EVENTS\` in \`templates/events.ts\`) and calls the same \`dispatch\` as \`/v1/email/send\`; \`/v1/events\` manages the mappings.`
  - In "Not in the MVP", remove `` `POST /v1/notifications` with event-based routing, ``.
- [ ] **Step 5: Verify and commit.**

```bash
wc -l README.md CLAUDE.md docs/web-app-integration*.md
git add README.md CLAUDE.md docs/web-app-integration.md docs/web-app-integration-events.md
git commit -m "docs: document event-based notifications"
```

**Deploy (manual):** `npm run db:migrate:remote` (migration `0005`) before `npm run deploy`.

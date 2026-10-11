# Event-based Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /v1/notifications` turns an event (`auth.password_reset`) into a template send through the existing pipeline. Each client maps events to templates via `/v1/events`, on top of built-in mappings.

**Architecture:**
- **Mappings:** a new `event_routes` D1 table holds per-client mappings, and `src/templates/events.ts` holds the built-in map and the resolution.
- **Sending:** the notifications route resolves the event and builds a normal `SendRequest`. It then calls a `dispatch` function extracted from `sendEmail`, so sync and async sending, idempotency and limits are reused unchanged.

**Tech Stack:** TypeScript on Cloudflare Workers, D1, and vitest in workerd via `@cloudflare/vitest-plugin`. No runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-10-11-notifications-design.md`](../specs/2026-10-11-notifications-design.md)

**Parts:**
1. This file: constraints, file map, task steps.
2. [Part 2](2026-10-11-notifications-part2.md): Task 1 tests and code.
3. [Part 3](2026-10-11-notifications-part3.md): Task 2 tests and code.
4. [Part 4](2026-10-11-notifications-part4.md): Task 3, documentation.

## Global Constraints

- **No runtime dependencies.** `vi.mock` does not work in the Workers pool: inject through `call(path, init, send, env)`, `recorder()` and `fakeQueue()` from `test/helpers.ts`.
- **Event names:** at most 64 characters, matching `^[a-z0-9_]+(\.[a-z0-9_]+)+$`.
- **Template names:** `^[a-z0-9-]{1,64}$`, which is the existing `NAME_RE`.
- **Error codes:**
  - `404 event_not_found` for an unknown event;
  - `404 template_not_found` for `PUT` to a missing template;
  - `400 validation_error` for bad input;
  - `400 invalid_variables` when `data` does not match the template.
- **`/v1/events` response shapes** mirror `src/routes/templates.ts`: the list carries `builtin` and `updated_at`, `PUT` answers `200` with the body, and `DELETE` answers `204`.
- **Built-in events:**

  | Event | Template |
  |---|---|
  | `user.welcome` | `welcome` |
  | `auth.email_verification` | `verify-email` |
  | `auth.password_reset` | `password-reset` |
  | `auth.password_changed` | `password-changed` |
  | `auth.login_alert` | `login-alert` |
  | `notification.generic` | `generic-notification` |

- **Deliveries:** `email_deliveries.template` stores the **resolved** template name. There is no `event` column.
- **Sync path unchanged:** every existing test passes unmodified.
- **Markdown:** every `.md` file stays under 200 lines.
- **Commands:**
  - `npx vitest run test/notifications.test.ts` for this feature's tests;
  - `npm test` for the full suite;
  - `npm run typecheck`.

## Review Focus

Inputs the spec implies but its test list did not cover. Each one has a test in its owning task.

1. **An `Idempotency-Key` reused across `/v1/notifications` and `/v1/email/send`** replays the first result and sends nothing. Task 2.
2. **`recipient` as `null`, an array, a string or `{}`** answers `400 validation_error`, never `500`. Task 2.
3. **A client mapping to a client template that exists only in `it`:** sending with `it` works, and with `en` answers `404 template_not_found`, never `500`. Task 2.
4. **Wrong methods:** `GET /v1/notifications` answers `405`, and so does `POST /v1/events`. Tasks 1 and 2.
5. **An event name of 65 characters, uppercase or with an empty segment** answers `400`. Task 1.

## File Map

| File | Change | Responsibility |
|---|---|---|
| `migrations/0005_event_routes.sql` | create | `event_routes` table |
| `src/templates/events.ts` | create | `BUILTIN_EVENTS`, `findEventRoute`, `resolveEvent`, `templateExists` |
| `src/security/validation.ts` | modify | `parseEvent`, `parseEventRoute`, `parseNotification`, shared `parseTarget` |
| `src/routes/events.ts` | create | `listEvents`, `getEvent`, `putEvent`, `deleteEvent` |
| `src/routes/email.ts` | modify | extract `dispatch` out of `sendEmail` |
| `src/routes/notifications.ts` | create | `sendNotification` |
| `src/index.ts` | modify | `/v1/events[/:event]` and `/v1/notifications` routes |
| `test/notifications.test.ts` | create | events CRUD and notifications tests |
| `docs/web-app-integration-events.md` | create | caller guide |
| `docs/web-app-integration.md`, `README.md`, `CLAUDE.md` | modify | links, API section, architecture |

---

### Task 1: Event mappings and the `/v1/events` CRUD

**Files:**
- Create: `migrations/0005_event_routes.sql`, `src/templates/events.ts`, `src/routes/events.ts`, `test/notifications.test.ts`
- Modify: `src/security/validation.ts`, `src/index.ts`

**Interfaces (produced, for Task 2):**
- `BUILTIN_EVENTS: Readonly<Record<string, string>>`
- `findEventRoute(db: D1Database, clientId: string, event: string): Promise<{ template: string; builtin: boolean } | null>`
- `resolveEvent(db: D1Database, clientId: string, event: string): Promise<string>`, which throws `404 event_not_found`
- `templateExists(db: D1Database, clientId: string, name: string): Promise<boolean>`
- `parseEvent(raw: unknown): string` and `parseEventRoute(body: Record<string, unknown>): { template: string }`
- Test helpers in `test/notifications.test.ts`: `custom`, `putEvent(key, event, body)`

- [ ] **Step 1: Write the failing tests.** Create `test/notifications.test.ts` with the code in [Part 2, "Task 1 tests"](2026-10-11-notifications-part2.md#task-1-tests).
- [ ] **Step 2: Run the tests.** Command: `npx vitest run test/notifications.test.ts`. Expected: FAIL, because `/v1/events` answers `404` where `200` is expected.
- [ ] **Step 3: Write the migration and code.** Use [Part 2, "Task 1 code"](2026-10-11-notifications-part2.md#task-1-code).
- [ ] **Step 4: Run everything.** Command: `npm test && npm run typecheck`. Expected: all tests pass, and `tsc` reports no errors.
- [ ] **Step 5: Commit.**

```bash
git add migrations/0005_event_routes.sql src/templates/events.ts src/routes/events.ts src/security/validation.ts src/index.ts test/notifications.test.ts
git commit -m "feat: add per-client event mappings and the /v1/events API"
```

### Task 2: `POST /v1/notifications`

**Files:**
- Create: `src/routes/notifications.ts`
- Modify: `src/routes/email.ts`, `src/security/validation.ts`, `src/index.ts`
- Test: `test/notifications.test.ts` (append)

**Interfaces:**
- **Consumes:** `resolveEvent` and `parseEvent` (Task 1), and the `custom` helper (Task 1 tests).
- **Produces:**
  - `dispatch(req: Request, env: Env, clientId: string, request: SendRequest, send: SendMailFn, ctx?: ExecutionContext): Promise<Response>`
  - `parseNotification(body): NotificationRequest`, where `NotificationRequest` is `{ event: string; to: string; locale: Locale; variables: Record<string, string> }`
  - `sendNotification(req, env, clientId, send, ctx?)`

- [ ] **Step 1: Write the failing tests.** Append the code in [Part 3, "Task 2 tests"](2026-10-11-notifications-part3.md#task-2-tests) to `test/notifications.test.ts`.
- [ ] **Step 2: Run the tests.** Command: `npx vitest run test/notifications.test.ts`. Expected: the new tests FAIL, because `/v1/notifications` answers `404` where `200` is expected. The Task 1 tests still pass.
- [ ] **Step 3: Implement.** Use [Part 3, "Task 2 code"](2026-10-11-notifications-part3.md#task-2-code).
- [ ] **Step 4: Run everything.** Command: `npm test && npm run typecheck`. Expected: all tests pass, including the unchanged `/v1/email/send` tests.
- [ ] **Step 5: Commit.**

```bash
git add src/routes/notifications.ts src/routes/email.ts src/security/validation.ts src/index.ts test/notifications.test.ts
git commit -m "feat: add event-based POST /v1/notifications"
```

### Task 3: Documentation

The steps are in [Part 4](2026-10-11-notifications-part4.md).

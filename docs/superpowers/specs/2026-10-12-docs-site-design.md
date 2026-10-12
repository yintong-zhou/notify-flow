# notify-flow docs site — design

Date: 2026-10-12. Status: approved in brainstorming, pending written-spec review.

## Goal

A static website for notify-flow with three areas:

- **Home**: presents the project.
- **Documentation**: explains what the service does and how to use it.
- **API Reference**: the technical contract of every endpoint.

It serves two audiences: people evaluating notify-flow to self-host it (coming from GitHub), and developers of apps that integrate an existing instance.

Constraints agreed with the user:

- English only, matching the existing docs.
- Hosted on Cloudflare Pages.
- **Single source of truth:** the site is generated from the repository's Markdown files. No page content is written only for the site.

## Approach

VitePress, with `docs/` as its root (the standard VitePress layout). It renders Markdown natively, resolves relative `.md` links, and ships sidebar, local search, code highlighting, dark mode and GitHub-style alerts (`> [!NOTE]`). Its build fails on dead links, which gives a free link check.

Rejected:

- A hand-written Node build script with `marked`: navigation, search and highlighting would be reinvented.
- Docsify: renders client-side, so SEO is poor for the public showcase and there is no build-time link check.

## Structure

```text
docs/
├── .vitepress/config.mts     # nav, sidebar, srcExclude, local search, brand color
├── index.md                  # Home (new)
├── getting-started.md        # new: includes README regions
├── web-app-integration*.md   # existing → Documentation
├── ai-integration-prompt.md  # existing → Documentation
├── api-reference.md          # new → API Reference, overview
├── api-reference-email.md    # new → sending endpoints
├── api-reference-config.md   # new → events, templates, health
└── superpowers/ handoff/ requirements/   # excluded via srcExclude
```

- `vitepress` is a **devDependency of the root `package.json`**. The Worker keeps zero runtime dependencies. Accepted cost: `npm install` also pulls Vite and Vue.
- New scripts: `docs:dev` (`vitepress dev docs`), `docs:build` (`vitepress build docs`) and `docs:preview` (`vitepress preview docs`).
- `.gitignore` gains `docs/.vitepress/dist` and `docs/.vitepress/cache`.

### Navigation

- Top nav: Home, Documentation (links to `getting-started`), API Reference (links to `api-reference`), and GitHub (`https://github.com/yintong-zhou/notify-flow`, as a social link).
- Documentation sidebar:
  - Getting started
  - Integration guide: overview (`web-app-integration`), Flows and production, Asynchronous sending, Event-based sending
  - AI integration prompt
- API Reference sidebar: Overview, Sending, Events and templates.

## Content

### Home (`docs/index.md`)

The VitePress `home` layout.

- **Hero:** name `notify-flow` and tagline *Self-hosted transactional email for Cloudflare Workers, over plain SMTP*.
- **Hero actions:** Get started (`/getting-started`), API Reference (`/api-reference`), GitHub.
- **Below the hero:** the README's "Why" and "How it works" sections, pulled in as regions. No `features` cards, because they would duplicate that text.
- **Example:** one `curl` example of `POST /v1/email/send`.

### README regions

The sections the site reuses are wrapped in `<!-- #region name -->` / `<!-- #endregion name -->` comments, which GitHub does not display. Site pages include them with `<!--@include: ../README.md#name-->`.

| Region | README section | Included by |
|---|---|---|
| `why` | Why | `index.md` |
| `how-it-works` | How it works | `index.md` |
| `getting-started` | Getting started | `getting-started.md` |
| `smtp-configuration` | SMTP configuration | `getting-started.md` |
| `security` | Security | `getting-started.md` |

None of these regions contains a relative link, so the links resolve the same way from `docs/`. The implementation must keep it that way. If a relative link is ever added to one of them, the build fails on it, which is the intended signal.

### Getting started (`docs/getting-started.md`)

A short intro for self-hosters, then the three included regions, then a "Next" link to the integration guide and the API Reference.

### API Reference

New files, each under 200 lines, written from the code (`src/index.ts`, `src/routes/`, `src/security/`, `src/services/`) and not copied from the existing docs.

| File | Content |
|---|---|
| `api-reference.md` | Base URL, authentication (`Authorization: Bearer` / `X-API-Key`), common headers (`Content-Type`, `Idempotency-Key`, `Prefer: respond-async`), 256 KB body limit, rate limits (IP, client, recipient), error shape `{"error":{"code","message"}}`, full error table, delivery statuses |
| `api-reference-email.md` | `POST /v1/email/send`, `GET /v1/email/:id`, `POST /v1/notifications` |
| `api-reference-config.md` | `GET /v1/events`, `GET`/`PUT`/`DELETE /v1/events/:event`, `GET /v1/templates`, `GET`/`PUT`/`DELETE /v1/templates/:name`, `GET /health` |

Every endpoint section follows the same fixed shape:

- method and path, with a one-line purpose;
- headers;
- body fields table with the validation rules;
- responses (status and JSON example);
- errors specific to the endpoint;
- `curl` example.

The error table covers every `HttpError` code thrown in `src/`:

- `invalid_json`, `validation_error`, `invalid_variables`
- `unauthorized`
- `not_found`, `template_not_found`, `event_not_found`
- `method_not_allowed`, `payload_too_large`, `rate_limited`
- `smtp_misconfigured`, `internal_error`, `smtp_failed`, `queue_unavailable`

Before writing the table, the implementation must re-check the codes with `grep -rn HttpError src`, including codes built outside the `HttpError(status, "code"` pattern.

Statuses: `accepted`, `queued`, `processing`, `submitted`, `failed`, `retrying`. The page states that `submitted` means SMTP acceptance, not inbox delivery.

### Deduplication

The full contract (field rules and the error table) lives only in the API Reference.

- **README, "API" section:** reduced to one send example and a link to the API Reference. Since the README is read on GitHub, the link points to `docs/api-reference.md`.
- **`web-app-integration.md`:** keeps the `curl` example and the practical guidance (what to do on retries and on `4xx`). Its fields table and error table are replaced by links to the API Reference. Same for the error sections of `-async.md`, `-events.md` and `-flows.md`, where they restate the contract.
- **`web-app-integration.md` line 3:** the link to `../README.md` (outside the VitePress root) becomes `getting-started.md`.
- **Deliberate exception:** `ai-integration-prompt.md` stays self-contained, because it is pasted into an agent that cannot follow links. Its "API contract" section keeps its copy of the contract. A one-line maintainer note (an HTML comment, outside the pasted prompt) says to update it together with `docs/api-reference*.md`.

## Deploy

Cloudflare Pages through the dashboard's Git integration, with no deploy code in the repo:

- project `notify-flow-docs` → `notify-flow-docs.pages.dev`;
- production branch `main`, preview deploys for other branches;
- build command `npm run docs:build`, output directory `docs/.vitepress/dist`;
- environment variable `NODE_VERSION=22`.

The build does not read `wrangler.jsonc` (git-ignored), so its absence on Pages is fine. The README gains a short "Docs site" section with these settings and the `docs:*` commands.

## Side updates

- `CLAUDE.md`: add the `docs:*` commands, and a note that API contracts live in `docs/api-reference*.md` (the AI prompt keeps a copy that must be updated with it).
- README "Project structure": the `docs/` line mentions the site.

## Verification

- `npm run docs:build` passes, with the dead-link check left on (no `ignoreDeadLinks`).
- Every endpoint, method, field rule and error code in the API Reference matches `src/`. Methods come from the `allow(...)` calls in `src/index.ts`, validation rules from `src/security/`.
- Every `.md` file stays under 200 lines.
- `npm test` and `npm run typecheck` are unaffected: `docs/` is outside `tsconfig.json` `include` and has no test files.
- Visual check with `npm run docs:preview`: Home hero and README regions render, the sidebar works, search finds endpoint names, dark mode works, and GitHub alerts render as callouts.

## Out of scope

- Custom domain (it can be added from the dashboard later).
- OpenAPI spec or an interactive "try it" playground.
- Versioned docs and translations.
- Analytics.
- Custom theme beyond setting the brand color on the default theme.

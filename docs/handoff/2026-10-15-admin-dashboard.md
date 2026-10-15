---
type: handoff
date: 2026-10-15
status: pronto per merge e deploy
seq: 1
prev: nessuno (handoff precedente su altro filone: docs/handoff/2026-10-12-notify-flow-mvp.md)
tags: [admin, dashboard, logs, d1, cloudflare-workers]
---

# Handoff — dashboard admin di notify-flow

## Obiettivo

Una dashboard `/admin/` nello stesso Worker per **monitorare il servizio**: capire se una mail/notifica è stata generata, inviata o è fallita, e perché. Login con registrazione **una sola volta** al primo accesso (un solo admin), statistiche, gestione account, log viewer. Roadmap in 3 sotto-progetti: 1 dashboard+auth, 2 log viewer, 3 editor DB.

## A che punto siamo

- **Sotto-progetto 1 (dashboard + auth + account): fatto.** Branch `feat/admin-dashboard`. Spec `docs/superpowers/specs/2026-10-15-admin-dashboard-design.md`, piano `docs/superpowers/plans/2026-10-15-admin-dashboard*.md`. Problemi minori della review già corretti (`c88c1fe`).
- **Sotto-progetto 2 (log viewer): fatto.** Spec `docs/superpowers/specs/2026-10-15-admin-logs-design.md`, piano `docs/superpowers/plans/2026-10-15-admin-logs*.md`. Su GitHub la **PR #2 ha già unito `feat/admin-logs` dentro `feat/admin-dashboard`** (`origin/feat/admin-dashboard` = `2cdc278`).
- **`main` non contiene ancora nulla del codice** (è a `8cabd10`, solo la spec della dashboard). **Nessun deploy fatto.**
- Test: 167/167, typecheck pulito, `docs:build` senza link morti. UI verificata in Chrome headless (non a occhio da una persona).
- **Sotto-progetto 3 (editor DB): non iniziato**, nemmeno il brainstorming.

## Cosa abbiamo provato che NON ha funzionato

- **Contare sullo storage D1 isolato per test** (il README di `@cloudflare/vitest-plugin` lo promette): in questo setup lo stato D1 è condiviso fra i test dello stesso file. Serve `beforeEach` che pulisce (`resetAdmin()` in `test/helpers.ts`, `DELETE FROM app_logs`/`email_deliveries` nei file nuovi).
- **Test 405 con metodo `toString`**: workerd rifiuta i metodi HTTP non standard già nel costruttore `Request`. Rimosso; la guardia `Object.hasOwn` nel router resta.
- **Script `task-start` di executing-plans** sui piani divisi in `-partN.md`: trova solo i task del file principale. BASE preso a mano da `git log`.
- **Reviewer subagent con worktree + junction a `node_modules`**: `git worktree remove --force` ha seguito la junction e cancellato quasi tutto `node_modules`. Ai reviewer va vietato esplicitamente worktree/junction/`npm ci`/comandi che scrivono.
- **Consigliare di cancellare `ADMIN_SETUP_TOKEN` dopo il setup**: è in `secrets.required`, senza di lui `npm run deploy` fallisce. Docs corrette: va lasciato (o sovrascritto con un valore nuovo).
- **Salvare il codice SMTP numerico (es. `550 5.1.1`) nei log**: `SmtpError` non lo espone, ha solo `code` interno + `message`, e `message` non va mai loggato (può contenere il destinatario). `detail` = `"smtp_timeout attempt 2/3"`.
- **Limite log per singolo IP**: aggirabile ruotando indirizzi IPv6 nello stesso /64. Ora la chiave è il /64 (`limitKey()` in `logger.ts`).
- **`TaskStop` su `wrangler dev` in background**: non uccide i processi figli `node`/`workerd`, che poi tengono file bloccati (EBUSY su `npm ci`).

## Problemi incontrati e come li abbiamo risolti

- **`node_modules` distrutto** → sintomo: moduli mancanti/EBUSY. Fermare i `wrangler dev` rimasti (PowerShell: `Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'notify-flow' -and $_.CommandLine -match 'wrangler|workerd' } | % { Stop-Process -Id $_.ProcessId -Force }`), poi `npm ci`.
- **Test `router.test.ts` "rate limits /v1/* per IP" flaky** (preesistente): 401 invece di 429 una volta su ~4 run completi, il ciclo di 301 richieste scavalca una finestra da 60 s. Rilanciare; non modificato.
- **Cookie `Secure` in locale**: usare `http://localhost:8787`, non `127.0.0.1`, nel browser.

## Decisioni prese

- **Login proprio con setup token** (`ADMIN_SETUP_TOKEN`) — scartati Cloudflare Access (niente codice, ma non era il flusso richiesto) e registrazione senza protezione (chi arriva primo diventa admin).
- **Un solo admin**, garantito da `CHECK (id = 1)` — scartati ruoli e più utenti (YAGNI per uso personale).
- **UI = static assets nello stesso Worker** (`public/admin/`, vanilla JS, SVG inline) — scartati progetto Pages/SPA (build, CORS, secondo deploy) e HTML generato in TS.
- **Sessioni in D1** (hash SHA-256 del token, 7 giorni) — scartati cookie firmati (non revocabili, niente "logout ovunque").
- **CSRF** = `SameSite=Strict` + POST solo `application/json` (415 altrimenti).
- **UI in inglese** come il resto del repo.
- **Log in tabella D1 `app_logs`** — scartati Workers Logs via Telemetry API (token account, retention breve) e solo dashboard Cloudflare.
- **`LOG_RATE_LIMITER` 30/min per IP (/64 IPv6)** per warn/info; errori e tentativi SMTP mai limitati — scartati aggregazione per minuto (limita righe, non scritture) e nessun limite.
- **IP completo conservato 30 giorni** — scartati IP troncato (inutile per bloccare) e nessun IP.
- **Esecuzione dei piani in modalità Native** + una review finale con subagent opus.

## File toccati

- `migrations/0006_admin.sql` — `admin_user`, `admin_sessions`.
- `migrations/0007_app_logs.sql` — `app_logs` + indice su `created_at`.
- `src/admin/auth.ts` — PBKDF2, confronto setup token, sessioni, `purgeSessions`.
- `src/admin/routes.ts` — router `/admin/api/*` (me, setup, login, logout, password, stats, deliveries, logs), `no-store`.
- `src/admin/stats.ts` — `stats`, `deliveries`, `logs` (filtri + cursore).
- `src/services/logger.ts` — `log()`, `logRequestError()`, `limitKey()`, `purgeLogs()`.
- `src/index.ts` — route `/admin/api/`, `errorResponse` unico punto di log, cron con purge sessioni e log.
- `src/services/email-service.ts`, `src/services/queue-consumer.ts` — log `smtp_attempt_failed`, via i vecchi `console.error`; `ABANDONED_AFTER_S` esportato.
- `src/security/rate-limit.ts` (`checkAdminLimit`), `src/security/validation.ts` (`EMAIL_RE` esportato).
- `public/admin/index.html`, `app.js`, `style.css`, `public/_headers` (CSP, nosniff, no-referrer).
- `test/admin.test.ts`, `test/admin-stats.test.ts`, `test/admin-logs.test.ts`, `test/logs.test.ts`, `test/helpers.ts`, `test/async-send.test.ts`.
- `wrangler.jsonc.example` (+ `wrangler.jsonc` locale), `vitest.config.ts`, `.dev.vars.example`.
- `docs/admin-dashboard.md`, `docs/.vitepress/config.mts`, `README.md`, `CLAUDE.md`.

## Dove vogliamo andare

1. **Allinea il locale**: `git switch feat/admin-dashboard && git pull` (il locale è a `c88c1fe`, il remoto a `2cdc278` con i log).
2. **Unisci `feat/admin-dashboard` in `main`** (PR su GitHub; `gh` non è installato, usare il sito).
3. **Deploy**: `npx wrangler secret put ADMIN_SETUP_TOKEN` → `npm run db:migrate:remote` (0006 e 0007) → `npm run deploy` → registrati su `https://<worker>.workers.dev/admin/`.
4. **Poi decidi** fra sotto-progetto 3 (editor DB: valutare prima se *D1 → Console* del dashboard Cloudflare basta) e i minori rimandati del log viewer:
   - errore sincrono non-SMTP dopo la prenotazione → `internal_error` senza `message_id`;
   - pager senza guardia contro risposte fuori ordine;
   - celle cliccabili (message id, IP, righe errori) non usabili da tastiera;
   - test mancanti: riga `internal_error`, 403/429 → warn, fallimento del solo insert log nel consumer;
   - nessun indice su `app_logs.ip` / `message_id`;
   - docs: i 4xx non-404 sono loggati su qualsiasi percorso, non solo `/v1` e `/admin/api`.

## Da sapere prima di toccare qualcosa

- **`wrangler.jsonc` è git-ignored**: ogni modifica di config va anche in `wrangler.jsonc.example` (lì ci sono già `ADMIN_RATE_LIMITER` 1003 e `LOG_RATE_LIMITER` 1004).
- **Stato locale di prova** (git-ignored): `.dev.vars` copiato dall'esempio (SMTP fittizio, `ADMIN_SETUP_TOKEN=change-me-to-a-long-random-string`); D1 locale con client `demo`, 63 invii di prova, admin `me@example.com` / `correct horse battery`, 3 righe di log.
- **Branch locale `feat/admin-logs`**: il suo ramo remoto è stato cancellato dopo il merge della PR #2; si può eliminare.
- **I limiter preesistenti** `IP_RATE_LIMITER` e `ADMIN_RATE_LIMITER` contano per singolo indirizzo IPv6, non per /64: con IPv6 un attaccante supera anche i 10 tentativi/min sul login admin. Non toccati.
- **Vincolo log** in `CLAUDE.md`: gli eventi passano solo da `log()` con i campi di `app_logs`; mai query string, `SmtpError.message` o messaggi di errori imprevisti.
- **Markdown < 200 righe** per ogni file; i piani lunghi sono divisi in `-partN.md`.

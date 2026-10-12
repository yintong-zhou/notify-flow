---
type: handoff
date: 2026-10-12
status: post-MVP su main, non pushato né deployato
seq: 2
prev: docs/handoff/2026-10-08-notify-flow-mvp.md
tags: [notify-flow, cloudflare-workers, d1, queues, smtp]
---

# Handoff — notify-flow dopo l'MVP: async, eventi, robustezza

## Obiettivo

Un servizio centralizzato su Cloudflare Workers per le email transazionali via SMTP diretto, riusabile da più web app, senza Resend, SendGrid o simili. In questa tranche abbiamo aggiunto l'invio asincrono e le notifiche per evento, e abbiamo reso robuste le transizioni di stato della coda. Il prossimo filone è la roadmap: firma HMAC delle richieste oppure XOAUTH2.

## A che punto siamo

- **`main`:** è a `e875fcf`, con **20 commit non pushati** su `origin`. Passano 123 test e il typecheck è pulito.
- **Invio asincrono** (`Prefer: respond-async` → `202 queued`):
  - lo stesso Worker consuma la coda `notify-flow-emails`, con 5 tentativi distanziati di 60, 300, 900 e 1800 secondi;
  - `GET /v1/email/:id` restituisce lo stato;
  - il cron chiude come `failed / abandoned` le righe `queued` o `retrying` più vecchie di 24 ore.
- **Notifiche per evento:**
  - `POST /v1/notifications` riceve `{event, recipient: {email, locale}, data}`;
  - `/v1/events` gestisce le mappature evento → template, per client, sopra 6 eventi predefiniti.
- **Robustezza (dopo la review adversarial di Codex):**
  - **Accodamento fallito:** la riga resta `queued` e il servizio risponde `503`; il retry con la stessa chiave rimette il messaggio in coda.
  - **Errore di D1 dopo il claim:** la transizione da applicare viene accodata in un messaggio di ripresa (`resume`), con il numero di tentativi come token.
- **Database remoto:** le migrazioni `0004` (`claimed_at`) e `0005` (`event_routes`) sono applicate.
- **Coda remota:** non so se `notify-flow-emails` esiste davvero. Non è stato verificato.
- **In produzione:** gira ancora il codice dell'MVP. Async ed eventi **non sono stati deployati**.
- **Documentazione:** README, guide d'integrazione (`-async.md`, `-events.md`, `-flows.md`), prompt di integrazione per agenti AI, CLAUDE.md e le spec e i piani in `docs/superpowers/`.

## Cosa abbiamo provato che NON ha funzionato

- **Contare il tempo per "abbandonato" da `created_at`:** una riga accodata 50 minuti fa e presa in carico ora risultava abbandonata durante l'invio. Si conta da `COALESCE(claimed_at, created_at)`, colonna aggiunta con la migrazione `0004`.
- **Marcare `failed / enqueue_failed` quando `queue.send` fallisce:** quell'`UPDATE` può fallire a sua volta e lasciare la riga `queued` per sempre senza nessun messaggio in coda. Ora la riga resta `queued`, la risposta è `503`, e il retry con la stessa chiave rimette in coda.
- **Retry semplice dopo una scrittura fallita dopo il claim:** il messaggio rientrato trova la riga in `processing` e la scarta con `ack`. Si perdevano i tentativi rimasti, oppure un'email inviata risultava `abandoned`. Sostituito dai messaggi di ripresa.
- **Inserire con `sed` codice che contiene regex con `\/`:** sed toglie i backslash (è successo con `EMAIL_PATH`). Per codice con regex usa lo strumento Edit.
- **Script `task-start` di superpowers sul primo file del piano:** cerca l'intestazione del task solo nel file che gli passi. Con i piani divisi in parti va lanciato sulla parte che contiene il task.
- **`/codex:review` senza argomenti su un working tree pulito:** non rivede niente. Per rivedere i commit usa `/codex:adversarial-review --base origin/main`.

## Problemi incontrati e come li abbiamo risolti

- **Test che passa subito, prima della correzione:** quando serve a proteggere un comportamento già corretto, verificalo con una mutazione. Si rompe temporaneamente il codice, si guarda il test fallire, poi si ripristina con `git checkout`. Fatto per l'isolamento tra client sulle mappature.
- **Test asincroni che arrivano al vero SMTP:** il binding reale `EMAIL_QUEUE` consegnerebbe i messaggi al consumer vero. Nei test inietta sempre `fakeQueue()` tramite `env`.
- **Test instabile** "rate limits /v1/* per IP before checking the API key": è fallito una volta, poi è passato in tre esecuzioni consecutive. La causa non è stata trovata; l'ipotesi è uno stato del limitatore per IP rimasto da un'esecuzione ravvicinata. Se fallisce, rilancialo prima di indagare.
- **`npm run db:migrate:remote` "non funzionava":** lo stato locale e quello remoto erano coerenti, e lato utente poi ha funzionato. La causa non è nota; le ipotesi erano il branch sbagliato o la conferma `y` interattiva.

## Decisioni prese

- **Async opt-in per richiesta** con `Prefer: respond-async` (RFC 7240). Scartati: sempre asincrono, e asincrono con opt-out.
- **Un solo Worker** che fa da producer e da consumer. Scartati: due Worker separati, e `202` con `waitUntil` senza coda (nessun retry durevole).
- **Esito tramite polling** con `GET /v1/email/:id`. Scartati i webhook.
- **Niente dead letter queue:** il cron chiude le righe bloccate da più di 24 ore.
- **Contratto del `503`:** si riprova con la **stessa** chiave. All'inizio era "con una nuova chiave", cambiato dopo la review di Codex.
- **Errore di scrittura dopo il claim:** passato a un messaggio di ripresa. Scartati: un lease sul claim (rischio di doppio invio dopo un invio riuscito) e una tabella outbox (rimandata, coprirebbe il caso in cui D1 e la coda sono giù insieme, segnato con un commento `ponytail:`).
- **Eventi come adattatore sottile:** la risoluzione evento → template passa poi per `dispatch`, condiviso con `/v1/email/send`. Scartati: una colonna di mappatura su `templates` e regole di instradamento generiche (YAGNI).
- **Mappature:** quelle predefinite stanno nel codice, quelle di ogni client in D1. Un evento produce una sola email. Niente colonna `event` in `email_deliveries`.
- **`Idempotency-Key` validata prima di leggere il corpo**, su entrambi gli endpoint.

## File toccati

- **`migrations/`:**
  - `0004_deliveries_claimed_at.sql`: la colonna `claimed_at`;
  - `0005_event_routes.sql`: la tabella delle mappature evento → template.
- **`src/services/`:**
  - `email-service.ts`: `reserveDelivery`, `findDelivery`, `mailMessage`, `enqueueTemplatedEmail` (che rimette in coda sulle richieste ripetute) e la chiusura delle righe bloccate nel cron;
  - `queue-consumer.ts` (nuovo): claim, invio, `record` con il ripiego sul messaggio di ripresa, `applyResume`.
- **`src/routes/`:**
  - `email.ts`: `dispatch` condiviso e `getEmail`;
  - `notifications.ts` e `events.ts` (nuovi).
- **`src/templates/events.ts`** (nuovo): `BUILTIN_EVENTS`, `findEventRoute`, `resolveEvent`, `templateExists`.
- **Altri file in `src/`:**
  - `security/validation.ts`: `parseTarget`, `parseNotification`, `parseEvent`, `parseEventRoute`;
  - `index.ts`: le nuove rotte e l'handler `queue`.
- **`test/`:**
  - `async-send.test.ts` e `notifications.test.ts` (nuovi);
  - `helpers.ts`: `fakeQueue()`.
- **Configurazione:** `wrangler.jsonc.example` e `wrangler.jsonc` locale (in `.gitignore`), con `queues` producer e consumer.
- **Documentazione:**
  - `README.md` e `CLAUDE.md`;
  - `docs/ai-integration-prompt.md` e `docs/web-app-integration*.md`;
  - le spec e i piani in `docs/superpowers/`.

## Dove vogliamo andare

1. Fai il push di `main` su `origin` e controlla che la coda esista (`npx wrangler queues list`; se manca, `npx wrangler queues create notify-flow-emails`). Poi lancia `npm run deploy` e verifica `GET /health`.
2. Scegli il prossimo punto della roadmap con la skill brainstorming:
   - **XOAUTH2:** il README avverte che Microsoft sta ritirando la basic auth per SMTP AUTH, ed è il rischio più concreto per chi usa il preset `microsoft`;
   - **firma HMAC** delle richieste (`X-Client-Id`, `X-Timestamp`, `X-Signature`).
3. In parallelo, se c'è tempo, sistema i minori ancora aperti dell'invio asincrono:
   - la regex di `Prefer` accetta anche `respond-async-v2`;
   - `max_retries` va portato a circa 10;
   - il commento sulle 24 ore di conservazione vale solo sul piano Free;
   - durante l'invio resta visibile l'`error_code` del tentativo precedente;
   - il cron non chiude le righe rimaste `processing`;
   - il controllo dei 413 avviene prima di quello di idempotenza;
   - la guida asincrona non elenca `smtp_misconfigured` e `internal_error`.

## Da sapere prima di toccare qualcosa

- **Ordine di deploy:** prima la migrazione, poi il deploy. Ora anche il percorso sincrono legge `claimed_at`.
- **La coda deve esistere prima di `npm run deploy`,** altrimenti il deploy fallisce.
- **`wrangler.jsonc` è in `.gitignore`:** le modifiche di configurazione vanno sia lì sia nel file `.example`.
- **Markdown:** ogni file `.md` deve restare sotto le 200 righe. I piani lunghi sono divisi in parti collegate.
- **Ledger di superpowers:** i ledger dei piani eseguiti sono stati cancellati, la storia è in git. `.superpowers/` è in `.gitignore`.
- **Secret:** non vanno mai scritti in file o in chat. Si inseriscono solo al prompt di `npx wrangler secret put`.

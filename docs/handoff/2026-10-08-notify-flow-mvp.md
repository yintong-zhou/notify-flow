---
type: handoff
date: 2026-10-08
status: MVP in produzione, minori aperti
seq: 1
prev: nessuno
tags: [notify-flow, cloudflare-workers, d1, smtp]
---

# Handoff — notify-flow MVP

## Obiettivo

Un servizio centralizzato su Cloudflare Workers per inviare email transazionali (benvenuto, verifica, reset password, alert di login) via SMTP diretto, riusabile da più web app. Lo scopo è evitare che ogni app integri SMTP e credenziali per conto suo, e non dipendere da Resend, SendGrid o servizi simili. Requisiti: `notification-service.md`.

## A che punto siamo

- **MVP completo:** è su `main` ed è pushato (`99b19e9`). Ci sono 67 test che passano (`npm test`) e il typecheck è pulito.
- **In produzione:** `https://notify-flow.jjservice.workers.dev`, con Gmail personale come provider.
  - Un invio reale fatto oggi è risultato `submitted`.
  - I secret SMTP sono impostati.
  - Le migrazioni D1 `0001` e `0002` sono applicate e registrate in `d1_migrations`.
- **Client su D1:** nessuno. Il client di test `claude-test` è stato eliminato.
- **Documentazione:** README, la guida d'integrazione in due parti e la spec in due parti. Tutti i file `.md` sono sotto le 200 righe.
- **Non iniziato:** i 7 problemi minori della revisione finale (vedi "Dove vogliamo andare") e la roadmap (code, XOAUTH2, HMAC, `/v1/notifications`, Web Push).

## Cosa abbiamo provato che NON ha funzionato

- **`vi.mock` nei test:** in `@cloudflare/vitest-plugin` non sostituisce i moduli del codice sotto test. Si usa l'iniezione di dipendenze: `handle(req, env, send, ctx)` e `sendMail(config, msg, connectFn, timeoutMs)`.
- **Tabelle D1 create dalla console Cloudflare:** il risultato è uno schema corretto, ma `d1_migrations` resta vuota, quindi wrangler poi tenta di riapplicare le migrazioni. Si risolve inserendo a mano i nomi in `d1_migrations`. Le tabelle vanno sempre create con `npm run db:migrate:remote`.
- **Heredoc bash multipli e lunghi** in un solo comando, per scrivere più file: si rompono nel parsing. I file vanno scritti con lo strumento Write, uno per uno.
- **`vitest` 5:** è incompatibile con il plugin, che richiede vitest `^4.1`.

## Problemi incontrati e come li abbiamo risolti

- **`tsc` fallisce su `SocketOptions`:** in workers-types 5.x il campo `allowHalfOpen` è obbligatorio. Si passa `allowHalfOpen: false`, che è il valore predefinito.
- **`tsc` fallisce su `clearTimeout`:** accetta `number | null`, quindi il timer si inizializza a `null`.
- **`wrangler dev` resta vivo dopo lo stop:** su Windows `workerd` rimane in ascolto sulla 8787. Si chiude con `taskkill //PID <pid-wrangler> //T //F`.
- **Hostname non risolto dopo il cambio di sottodominio workers.dev** (`zhouyintong96` è diventato `jjservice`): DNS e certificato TLS impiegano qualche minuto. Basta aspettare.
- **Microsoft 365:** non offre `AUTH PLAIN`. Il preset `microsoft` usa `login`.

## Decisioni prese

- **Approccio:** zero dipendenze di runtime e client SMTP scritto a mano. Scartati `worker-mailer` e la combinazione Hono + zod + Handlebars.
- **Template:** dati su D1 per client, con ripiego sui predefiniti in `src/templates/defaults.ts` (lingue `it`, `en`, `pt-BR`). Scartata l'idea di template solo nel codice, perché l'utente vuole che ogni client registri i propri.
- **Invio sincrono nell'MVP:** Cloudflare Queues resta in roadmap.
- **Limiti:** 60 richieste ogni 60 secondi per client, tramite il binding Rate Limiting. Il limite per destinatario è contato per client, ed esclude gli invii falliti.
- **Idempotenza:** la richiesta ripetuta ha la precedenza sul limite per destinatario. Una riga ancora in `processing` dopo 5 minuti viene chiusa come `failed/abandoned`.
- **Configurazione:** `SMTP_HOST`, `SMTP_PORT` e `SMTP_SECURITY` sono variabili, non secret, perché un Worker non può avere un secret e una variabile con lo stesso nome.
- **`wrangler.jsonc`:** è in `.gitignore`. Il file versionato è `wrangler.jsonc.example`.
- **Piano di implementazione:** cancellato dal repository dopo l'esecuzione. Resta in git, al commit `8cd663b`.

## File toccati

- `src/`: tutto il servizio (router, sicurezza, route, servizio email, template, SMTP).
- `test/`: 5 file di test, più `helpers.ts` e `fake-smtp.ts`.
- `migrations/0001_init.sql` e `migrations/0002_recipient_limit_per_client.sql`.
- `scripts/create-client.mjs`: crea un client e stampa la chiave una sola volta.
- `wrangler.jsonc.example`, `.gitignore` e `.dev.vars.example`.
- Documentazione:
  - `README.md` e `CLAUDE.md`;
  - `notification-service.md` più `docs/requirements/*`;
  - `docs/web-app-integration*.md`;
  - `docs/superpowers/specs/*`.

## Dove vogliamo andare

1. Correggi i problemi minori rimandati dalla revisione. Ognuno ha un test che deve fallire prima della correzione:
   1. In `src/services/email-service.ts`, sposta l'`UPDATE` a `submitted` fuori dal `try` che classifica gli errori di invio. Oggi un errore di D1 dopo un invio riuscito segna la riga `failed` e il chiamante può rinviare l'email.
   2. In `src/security/validation.ts`, restringi `EMAIL_RE` all'ASCII stampabile, senza `<>()[]\,;:@"`.
   3. In `src/smtp/smtp-client.ts`, fai in modo che la prima riga di `Subject:` stia entro 76 caratteri: usa una prima parola codificata di 39 byte, oppure vai a capo subito dopo `Subject:`.
   4. In `readJson`, rifiuta il corpo troppo grande già dall'header `Content-Length`, prima di leggerlo.
   5. Applica il timeout di 10 secondi anche alle scritture SMTP, non solo alle letture.
   6. In `src/index.ts`, il log degli errori imprevisti non deve più includere `e.message`.
   7. Con `RECIPIENT_LIMIT_PER_HOUR="0"` il limite deve valere 0. Oggi diventa 5.
2. Dopo: integra la prima web app reale, creando la sua chiave con `npm run client:create -- <app> --remote` e seguendo `docs/web-app-integration.md`.

## Da sapere prima di toccare qualcosa

- **Dopo un clone:** esegui `cp wrangler.jsonc.example wrangler.jsonc`, altrimenti test, `dev` e deploy non partono. Il vero `database_id` sta solo nel file locale.
- **File Markdown:** ognuno deve restare sotto le 200 righe. Se si allunga, dividilo in parti collegate tra loro.
- **Secret:** non si scrivono mai in file o in chat. Si inseriscono al prompt di `npx wrangler secret put`.
- **Typecheck:** `npm run typecheck` rigenera `worker-configuration.d.ts` (che è in `.gitignore`) e poi esegue `tsc`.

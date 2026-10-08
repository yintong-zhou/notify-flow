# Integrare notify-flow in una web app

Aggiornato al 2026-10-08

## Panoramica

Per inviare un'email transazionale, il backend della tua web app fa una sola chiamata HTTP a notify-flow, con il nome di un template e le sue variabili. notify-flow fa il resto e restituisce un id di invio.

| notify-flow si occupa di | La tua web app si occupa di |
| --- | --- |
| Autenticare la tua app con la chiave API | Decidere quando inviare (registrazione, reset, login…) |
| Scegliere il template e la lingua, compilare oggetto, HTML e testo | Generare token e link (verifica, reset) e controllarne la validità |
| Inviare via SMTP (Gmail, Microsoft 365 o SMTP generico) con retry | Conservare la chiave API solo nel backend |
| Applicare rate limit e idempotenza | Gestire l'esito della chiamata (errori, nuovi tentativi) |
| Registrare l'esito dell'invio | Mostrare all'utente un messaggio neutro |

notify-flow consegna email e basta: non conosce i tuoi utenti e non gestisce password o token.

## Prerequisiti

Ogni web app riceve dall'amministratore di notify-flow un URL e una chiave API propria. Le due cose vanno configurate nel backend della web app, mai nel frontend.

| Cosa | Valore | Dove va |
| --- | --- | --- |
| URL del servizio | `https://notify-flow.jjservice.workers.dev` | Variabile d'ambiente del backend, es. `NOTIFY_FLOW_URL` |
| Chiave API | `nf_…`, mostrata una sola volta alla creazione | Secret del backend, es. `NOTIFY_FLOW_API_KEY` |
| Nome dell'app | Testo libero, es. `Acme` | Passato a ogni invio come variabile `appName` |

L'amministratore crea la chiave con `npm run client:create -- <nome-app> --remote`. Usa una chiave per ogni web app: puoi revocarne una senza toccare le altre, e ogni app ha i propri template e i propri limiti.

Se la chiave finisce nel frontend, in un repository o in una chat, considerala compromessa: chiedi all'amministratore di crearne una nuova e di cancellare quella vecchia.

## Architettura

Il frontend non parla mai con notify-flow: chiede un'azione al backend della tua app, ed è il backend a chiamare notify-flow con la chiave API.

```text
┌──────────────────────────────────────────────────────────┐
│ Frontend (browser o app mobile)                          │
│ Chiede un'azione: registrazione, reset password, login.  │
│ Non conosce la chiave API e non chiama notify-flow.      │
└──────────────────────────────────────────────────────────┘
                             │  POST /forgot-password
                             ▼  (senza chiave API)
┌──────────────────────────────────────────────────────────┐
│ Backend della tua web app            ◄── da sviluppare   │
│ Verifica l'utente, genera token e link (verifica, reset).│
│ Custodisce la chiave API e chiama notify-flow.           │
└──────────────────────────────────────────────────────────┘
                             │  POST /v1/email/send con chiave e Idempotency-Key
                             ▼  risposta: id e status
┌──────────────────────────────────────────────────────────┐
│ notify-flow (Cloudflare Worker)                          │
│ Autentica la chiave, valida, applica limiti e idempotenza│
│ Compila il template, invia con retry, registra su D1.    │
└──────────────────────────────────────────────────────────┘
                             │
                             ▼  SMTP su TLS (465) o STARTTLS (587)
┌──────────────────────────────────────────────────────────┐
│ Server SMTP (Gmail, Microsoft 365 o altro)               │
│ Accetta il messaggio: l'invio risulta submitted.         │
└──────────────────────────────────────────────────────────┘
                             │
                             ▼  consegna
┌──────────────────────────────────────────────────────────┐
│ Casella email dell'utente                                │
└──────────────────────────────────────────────────────────┘
```

La parte da sviluppare è il box del backend. Tutto quello che c'è sotto lo gestisce notify-flow.

## Inviare un'email

Ogni invio è una `POST /v1/email/send`. Se va a buon fine risponde `200` con `{"id":"msg_…","status":"submitted"}`.

```bash
curl -X POST https://notify-flow.jjservice.workers.dev/v1/email/send \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: password-reset:user-123:req-456" \
  -d '{
    "template": "password-reset",
    "to": "mario.rossi@example.com",
    "locale": "it",
    "variables": {
      "appName": "Acme",
      "name": "Mario",
      "resetUrl": "https://app.acme.it/reset?token=..."
    }
  }'
```

| Campo | Obbligatorio | Regole |
| --- | --- | --- |
| `template` | sì | Nome del template: minuscole, numeri e trattini, al massimo 64 caratteri |
| `to` | sì | Un solo indirizzo, al massimo 254 caratteri, niente virgole né a capo |
| `locale` | no | `it`, `en` o `pt-BR`. Predefinito: `en` |
| `variables` | sì | Oggetto di sole stringhe, con esattamente le variabili dichiarate dal template |
| header `Authorization` | sì | `Bearer <chiave>`, oppure l'header `X-API-Key: <chiave>` |
| header `Idempotency-Key` | consigliato | Da 1 a 255 caratteri, unico per ogni azione dell'utente |

`submitted` significa che il server SMTP ha accettato il messaggio, non che sia arrivato nella casella del destinatario.

| Codice HTTP | `error.code` | Cosa fare |
| --- | --- | --- |
| 200 | — | Inviata, oppure risposta ripetuta per la stessa `Idempotency-Key` |
| 400 | `validation_error`, `invalid_json`, `invalid_variables` | Correggi il payload: riprovare non serve |
| 401 | `unauthorized` | Chiave mancante o errata: controlla la configurazione |
| 404 | `template_not_found` | Il template non esiste in quella lingua né in `en` |
| 413 | `payload_too_large` | Il corpo supera 256 KB |
| 429 | `rate_limited` | Troppe richieste: riprova più tardi |
| 500 | `smtp_misconfigured`, `internal_error` | Problema del servizio: avvisa l'amministratore |
| 502 | `smtp_failed` | Il server SMTP ha rifiutato dopo i retry. La risposta contiene l'`id` dell'invio |

In caso di errore la risposta ha sempre la forma `{"error":{"code":"…","message":"…"}}`.

## Esempi di codice backend

Basta una funzione che fa la `POST` e trasforma gli errori in eccezioni. Non serve nessuna libreria: `fetch` in Node 18+ e `requests` in Python.

Node.js / TypeScript:

```typescript
const NOTIFY_URL = process.env.NOTIFY_FLOW_URL!;      // https://notify-flow.jjservice.workers.dev
const NOTIFY_KEY = process.env.NOTIFY_FLOW_API_KEY!;  // nf_...

export async function sendEmail(opts: {
  template: string;
  to: string;
  variables: Record<string, string>;
  locale?: "it" | "en" | "pt-BR";
  idempotencyKey?: string;
}): Promise<{ id: string; status: string }> {
  const res = await fetch(`${NOTIFY_URL}/v1/email/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTIFY_KEY}`,
      "Content-Type": "application/json",
      ...(opts.idempotencyKey && { "Idempotency-Key": opts.idempotencyKey }),
    },
    body: JSON.stringify({
      template: opts.template,
      to: opts.to,
      locale: opts.locale ?? "it",
      variables: { appName: "Acme", ...opts.variables },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`notify-flow ${res.status} ${body.error?.code}`);
  return body;
}
```

Python:

```python
import os, requests

NOTIFY_URL = os.environ["NOTIFY_FLOW_URL"]
NOTIFY_KEY = os.environ["NOTIFY_FLOW_API_KEY"]

def send_email(template, to, variables, locale="it", idempotency_key=None):
    headers = {"Authorization": f"Bearer {NOTIFY_KEY}"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    res = requests.post(
        f"{NOTIFY_URL}/v1/email/send",
        json={"template": template, "to": to, "locale": locale,
              "variables": {"appName": "Acme", **variables}},
        headers=headers,
        timeout=30,
    )
    body = res.json()
    if not res.ok:
        raise RuntimeError(f"notify-flow {res.status_code} {body['error']['code']}")
    return body
```

Il timeout di 30 secondi serve perché in caso di errori temporanei notify-flow riprova l'invio prima di rispondere. Una risposta lenta è normale.

## Flussi comuni

Ogni evento della web app corrisponde a un template predefinito. Il backend genera link e token prima di chiamare notify-flow.

| Evento nella web app | Template | Variabili richieste | `Idempotency-Key` suggerita |
| --- | --- | --- | --- |
| Registrazione completata | `welcome` | `appName`, `name` | `welcome:<userId>` |
| Verifica dell'indirizzo email | `verify-email` | `appName`, `name`, `verifyUrl` | `verify:<userId>:<tokenId>` |
| Richiesta di reset password | `password-reset` | `appName`, `name`, `resetUrl` | `reset:<userId>:<tokenId>` |
| Password cambiata | `password-changed` | `appName`, `name` | `pwchanged:<userId>:<timestamp>` |
| Accesso da un nuovo dispositivo | `login-alert` | `appName`, `name`, `device`, `ipAddress`, `time` | `login:<sessionId>` |
| Comunicazione generica | `generic-notification` | `appName`, `title`, `message` | `notice:<eventId>` |

Esempio di reset password in un backend Express:

```typescript
app.post("/forgot-password", async (req, res) => {
  const user = await db.users.findByEmail(req.body.email);
  if (user) {
    const token = await createResetToken(user.id);   // salvato con scadenza, es. 30 minuti
    await sendEmail({
      template: "password-reset",
      to: user.email,
      locale: user.locale,
      variables: { name: user.firstName, resetUrl: `https://app.acme.it/reset?token=${token.value}` },
      idempotencyKey: `reset:${user.id}:${token.id}`,
    }).catch((err) => log.error("reset email failed", { userId: user.id, err: err.message }));
  }
  // Stessa risposta che l'utente esista o no: non rivela quali email sono registrate.
  res.json({ message: "Se l'indirizzo è registrato, riceverai un'email." });
});
```

Quattro regole valgono per tutti i flussi:

- **Token:** genera e verifica i token nel tuo backend. notify-flow riceve solo il link già pronto.
- **Variabili:** passa sempre `appName`, perché tutti i template predefiniti la usano nel più di pagina.
- **Lingua:** usa la lingua scelta dall'utente (`it`, `en`, `pt-BR`). Se non la conosci, viene usata `en`.
- **Tempo:** formatta `time` nel fuso e nella lingua dell'utente prima di inviarlo, es. `08/10/2026 14:32`.

## Template personalizzati

Ogni web app può registrare template propri, oppure sostituire quelli predefiniti, per una singola lingua. I template di un'app sono invisibili alle altre.

```bash
curl -X PUT https://notify-flow.jjservice.workers.dev/v1/templates/order-shipped/it \
  -H "Authorization: Bearer $NOTIFY_FLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "Il tuo ordine {{orderId}} è in viaggio",
    "html": "<p>Ciao {{name}},</p><p>abbiamo spedito l'\''ordine {{orderId}}. <a href=\"{{trackingUrl}}\">Segui la spedizione</a>.</p>",
    "text": "Ciao {{name}},\nabbiamo spedito l'\''ordine {{orderId}}: {{trackingUrl}}",
    "variables": ["name", "orderId", "trackingUrl"]
  }'
```

| Metodo e percorso | Cosa fa |
| --- | --- |
| `GET /v1/templates` | Elenca i tuoi template e quelli predefiniti (questi ultimi con `builtin: true`) |
| `GET /v1/templates/:name/:locale` | Restituisce un template: il tuo se esiste, altrimenti quello predefinito |
| `PUT /v1/templates/:name/:locale` | Crea o aggiorna un template |
| `DELETE /v1/templates/:name/:locale` | Cancella un tuo template. Quelli predefiniti non si cancellano |

Come si scrivono i template:

- **Segnaposto:** si scrivono `{{nomeVariabile}}`, e ognuno deve comparire nell'elenco `variables`. Altrimenti il `PUT` risponde `400`.
- **Sicurezza dei valori:** nell'`html` i valori vengono sempre convertiti in testo sicuro, quindi un nome come `<script>` non viene eseguito. Nell'oggetto gli a capo vengono rimossi.
- **Limiti:** oggetto 255 caratteri su una sola riga, `html` 100 KB, `text` 50 KB.
- **Ordine di ricerca all'invio:** prima il tuo template nella lingua richiesta, poi quello predefinito nella stessa lingua, infine la stessa ricerca in `en`. Puoi quindi sostituire un solo template predefinito in una sola lingua.
- **Contenuto fisso:** tieni nel template tutto il testo che non cambia. Le variabili servono solo ai dati del singolo invio: un contenuto passato da fuori aumenta il rischio di abuso se la chiave viene rubata.

## Errori, retry e idempotenza

Riprova solo con la stessa `Idempotency-Key`: così un nuovo tentativo non produce mai una seconda email. notify-flow fa già fino a 3 tentativi verso SMTP prima di rispondere.

| Esito | Riprovare? | Come |
| --- | --- | --- |
| Timeout o errore di rete verso notify-flow | sì | Stessa `Idempotency-Key`, dopo qualche secondo |
| `429 rate_limited` | sì, più tardi | Dopo almeno un minuto. Il limite per destinatario vale per un'ora |
| `500` | sì, più tardi | Stessa chiave. Se si ripete, avvisa l'amministratore |
| `502 smtp_failed` | solo se l'utente lo chiede | Con una chiave **nuova**: quella vecchia restituisce di nuovo `failed` |
| `400`, `401`, `404`, `413` | no | Errore di integrazione: correggi il codice o la configurazione |

Come funziona l'idempotenza:

- **Stessa chiave:** la stessa `Idempotency-Key` dalla stessa app restituisce sempre il primo risultato (`id` e `status`), senza inviare di nuovo. Vale anche dopo il limite per destinatario.
- **Una chiave per azione:** la chiave identifica l'azione dell'utente, non la chiamata HTTP. Due richieste di reset fatte dall'utente sono due azioni: due chiavi.
- **Senza chiave:** ogni chiamata invia un'email.
- **Invio interrotto:** se una richiesta resta in `processing` per più di 5 minuti, una ripetizione con la stessa chiave la chiude come `failed`. In questo caso l'email potrebbe essere partita lo stesso.

Limiti di frequenza:

- **Per app:** 60 richieste al minuto, su tutte le route `/v1/*`.
- **Per destinatario:** 5 email all'ora per lo stesso destinatario e lo stesso template, nella tua app. Gli invii falliti non contano. Il valore è configurabile dall'amministratore.

Un invio fallito non deve bloccare la richiesta dell'utente: registra l'errore nei log e mostra il messaggio neutro previsto dal flusso.

## Sicurezza e buone pratiche

La chiave API dà a chi la possiede il diritto di inviare email a nome del servizio, quindi va protetta come una password.

- **Solo backend:** il frontend non chiama mai notify-flow. Chiama un endpoint della tua app (`/forgot-password`, `/register`), che decide se l'invio è lecito.
- **Niente invii a comando:** non esporre endpoint del tipo "invia questa email a questo indirizzo". Ogni invio nasce da un'azione verificata dal backend.
- **Limiti anche nella tua app:** limita i tentativi di reset e di registrazione per IP e per account. I limiti di notify-flow sono l'ultima difesa, non la prima.
- **Token brevi e monouso:** i link di verifica e di reset devono scadere (es. 30 minuti per il reset) e valere una sola volta.
- **Log puliti:** non scrivere nei log le variabili inviate, in particolare `resetUrl` e `verifyUrl`, né la chiave API. Basta l'`id` restituito da notify-flow.
- **Risposte neutre:** per reset e registrazione rispondi sempre allo stesso modo, che l'email esista o no.
- **Rotazione:** se la chiave potrebbe essere stata esposta, falla sostituire subito. Ogni app ha la sua, quindi le altre non ne risentono.
- **Mittente:** l'indirizzo mittente è quello configurato in notify-flow. Con Gmail deve coincidere con l'account che invia, altrimenti Gmail lo riscrive.

## Checklist per la produzione

- [ ] Chiave API dedicata all'app, salvata come secret del backend
- [ ] `NOTIFY_FLOW_URL` e `NOTIFY_FLOW_API_KEY` configurati in ogni ambiente (sviluppo, staging, produzione)
- [ ] Nessuna chiamata a notify-flow dal frontend
- [ ] `Idempotency-Key` impostata su ogni invio, unica per azione dell'utente
- [ ] Timeout HTTP del client di almeno 30 secondi
- [ ] Errori `400`, `401` e `404` registrati nei log come bug di integrazione
- [ ] `429`, `500` ed errori di rete ripetuti con la stessa chiave
- [ ] Risposte neutre per reset password e registrazione
- [ ] Token di verifica e di reset monouso e con scadenza
- [ ] Nei log solo l'`id` dell'invio, mai variabili o link
- [ ] Template personalizzati creati e provati per ogni lingua usata
- [ ] Un invio di prova per ogni template verso una casella interna, controllando anche lo spam

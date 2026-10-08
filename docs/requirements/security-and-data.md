# Cloudflare Email Notification Service — Security and data

Part of the requirements in [notification-service.md](../../notification-service.md).

## Security

The service must not be publicly usable without authentication.

Each authorized application should have its own API key.

```http
Authorization: Bearer SERVICE_API_KEY
```

or:

```http
X-API-Key: SERVICE_API_KEY
```

API keys must not be stored in plain text in the database.

For a more advanced version, HMAC signatures can be used:

```text
X-Client-Id
X-Timestamp
X-Signature
```

with the signature computed as:

```text
HMAC-SHA256(timestamp + request_body, client_secret)
```

---

## SMTP credential management

SMTP passwords must not be:

- placed in the frontend;
- present in the repository;
- hardcoded in the code;
- saved in public files;
- included in logs.

For a simple setup, credentials can be stored via **Cloudflare Secrets**.

If the service later needs to support multiple dynamic SMTP accounts or multiple customers, credentials can be stored encrypted in a database, keeping the master encryption key in Cloudflare Secrets.

---

## Separation between frontend and backend

For sensitive endpoints, the frontend must not be able to send arbitrary requests such as:

```json
{
  "to": "qualunque@email.com",
  "subject": "test",
  "html": "<h1>...</h1>"
}
```

Instead, the frontend must request an application action, for example:

```text
forgot-password
register
change-email
login
```

The backend verifies the operation and, if valid, calls the Notification Service.

This prevents spam, abuse of the service, impersonation, arbitrary email sending, and template manipulation.

---

## Rate limiting

The service must implement configurable usage limits.

Example:

```text
password-reset:
5 requests per email / hour

API client:
100 requests / minute
```

---

## Idempotency

Sensitive requests should support an idempotency key.

```http
Idempotency-Key: password-reset:user-123:request-456
```

If the same request is sent multiple times, the service must avoid sending duplicates.

---

## Logging

Each send request can produce an internal record:

```text
email_deliveries
----------------
id
request_id
client_id
template
provider
recipient
status
created_at
sent_at
attempts
error_code
```

Passwords, sensitive tokens, SMTP credentials, and plain-text reset tokens must not be stored in logs.

---

## Storage (Cloudflare D1)

Persistent data lives in **Cloudflare D1** (SQLite). The schema is versioned with `wrangler d1 migrations`, without an ORM.

| Need | Where | How |
|---|---|---|
| Delivery log | D1 `email_deliveries` | One row per send request |
| Client API keys | D1 `clients` | SHA-256 hash of the key via `crypto.subtle`. Keys are random and high-entropy, so bcrypt is not needed. |
| Idempotency | D1 `email_deliveries` | `UNIQUE(client_id, idempotency_key)`: a duplicate `INSERT` fails atomically, so the database does the deduplication |
| Per-recipient limit (e.g. 5 password-reset / email / hour) | D1 `email_deliveries` | `COUNT(*)` over the last hour, with no separate counter table |
| Per-client limit (e.g. 100 requests / minute) | Workers Rate Limiting binding | Supports 10 s or 60 s periods only and its counts are approximate, which is enough here. It avoids a D1 write per request just to count. |
| Encrypted SMTP credentials (post-MVP) | D1 | Encrypted per row, with the master key in Cloudflare Secrets |

KV is not used for idempotency: it is eventually consistent and would let duplicates through.

```sql
CREATE TABLE clients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,   -- hex SHA-256 of the API key
  created_at INTEGER NOT NULL        -- unix seconds
);

CREATE TABLE email_deliveries (
  id              TEXT PRIMARY KEY,  -- msg_...
  request_id      TEXT NOT NULL,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  idempotency_key TEXT,              -- NULL when the header is absent
  template        TEXT NOT NULL,
  provider        TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                    ('accepted','queued','processing','submitted','failed','retrying')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  created_at      INTEGER NOT NULL,  -- unix seconds
  sent_at         INTEGER,
  UNIQUE (client_id, idempotency_key)
);

CREATE INDEX idx_deliveries_rate ON email_deliveries (recipient, template, created_at);
```

Per-recipient rate limit check:

```sql
SELECT COUNT(*) FROM email_deliveries
WHERE recipient = ? AND template = ? AND created_at > unixepoch() - 3600;
```

Notes:

- **Write budget.** D1 has a single primary that accepts writes, and plans cap the rows written per day. A send costs about 2 writes (the insert, then the status update), which is fine for transactional volume. Check the current D1 limits before sizing.
- **Retention.** A daily Cron Trigger deletes `email_deliveries` rows older than 30 days, in batches.
- **No sensitive data.** The table never stores variables, rendered bodies, reset URLs or tokens.

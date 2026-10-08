CREATE TABLE clients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,   -- hex SHA-256 of the API key
  created_at INTEGER NOT NULL        -- unix seconds
);

CREATE TABLE templates (
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  locale     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  html       TEXT NOT NULL,
  text       TEXT NOT NULL,
  variables  TEXT NOT NULL,          -- JSON array of allowed variable names
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, name, locale)
);

CREATE TABLE email_deliveries (
  id              TEXT PRIMARY KEY,  -- msg_<uuid>
  request_id      TEXT NOT NULL,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  idempotency_key TEXT,
  template        TEXT NOT NULL,
  provider        TEXT NOT NULL,
  recipient       TEXT NOT NULL,     -- lowercased
  status          TEXT NOT NULL CHECK (status IN
                    ('accepted','queued','processing','submitted','failed','retrying')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE (client_id, idempotency_key)
);

CREATE INDEX idx_deliveries_rate ON email_deliveries (recipient, template, created_at);

-- Off by default: a client opts in from the admin dashboard.
ALTER TABLE clients ADD COLUMN push_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE push_subscriptions (
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL,     -- push service URL; host on the allowlist
  user_id    TEXT NOT NULL,     -- the caller's own user id, opaque to notify-flow
  p256dh     TEXT NOT NULL,     -- browser public key, base64url (65 bytes decoded)
  auth       TEXT NOT NULL,     -- browser auth secret, base64url (16 bytes decoded)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, endpoint)
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (client_id, user_id, created_at);

CREATE TABLE push_deliveries (
  id              TEXT PRIMARY KEY,  -- psh_<uuid>
  request_id      TEXT NOT NULL,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  idempotency_key TEXT,
  template        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  tag             TEXT,              -- the caller's conversation id, if given: keys the hourly limit
  status          TEXT NOT NULL CHECK (status IN ('processing','submitted','failed')),
  devices         INTEGER NOT NULL DEFAULT 0,  -- subscriptions the push service accepted
  error_code      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE (client_id, idempotency_key)
);
CREATE INDEX idx_push_deliveries_rate ON push_deliveries (client_id, user_id, created_at);

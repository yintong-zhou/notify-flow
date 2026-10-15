CREATE TABLE admin_user (
  id            INTEGER PRIMARY KEY CHECK (id = 1),  -- one admin only
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,                       -- pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>
  created_at    INTEGER NOT NULL
);
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,                        -- hex SHA-256 of the cookie value
  expires_at INTEGER NOT NULL                         -- unix seconds
);

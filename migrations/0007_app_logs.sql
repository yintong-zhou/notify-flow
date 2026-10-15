CREATE TABLE app_logs (
  id         INTEGER PRIMARY KEY,               -- rowid: insertion order, used as the cursor
  created_at INTEGER NOT NULL,                  -- unix seconds
  level      TEXT NOT NULL CHECK (level IN ('error', 'warn', 'info')),
  code       TEXT NOT NULL,                     -- error code, e.g. smtp_failed, unauthorized, smtp_attempt_failed
  status     INTEGER,                           -- HTTP status; NULL outside a request
  method     TEXT,
  path       TEXT,                              -- pathname only, never the query string; at most 128 characters
  client_id  TEXT,                              -- when already authenticated
  message_id TEXT,                              -- msg_… when the event concerns a delivery
  ip         TEXT,                              -- CF-Connecting-IP
  detail     TEXT                               -- fixed vocabulary only, e.g. "smtp_timeout attempt 2/3"
);
CREATE INDEX idx_logs_created ON app_logs (created_at);

-- Per-client event → template mappings, on top of the built-ins in src/templates/events.ts.
CREATE TABLE event_routes (
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  template   TEXT NOT NULL,      -- template name; the locale is chosen at send time
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, event)
);

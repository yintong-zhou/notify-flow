-- The per-recipient limit is counted per client, so one client cannot exhaust another client's quota.
DROP INDEX idx_deliveries_rate;
CREATE INDEX idx_deliveries_rate ON email_deliveries (client_id, recipient, template, created_at);

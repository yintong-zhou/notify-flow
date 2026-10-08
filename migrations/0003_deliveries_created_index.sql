-- Lets the retention cron find old rows without scanning the whole table.
CREATE INDEX idx_deliveries_created ON email_deliveries (created_at);

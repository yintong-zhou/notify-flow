-- When the queue consumer claimed the row; the abandoned rule counts from it (created_at on the sync path).
ALTER TABLE email_deliveries ADD COLUMN claimed_at INTEGER;

-- Disabled until an administrator explicitly enables admission for a Service.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS queue_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS queue_rate INT UNSIGNED NOT NULL DEFAULT 2;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS queue_capacity INT UNSIGNED NOT NULL DEFAULT 2000;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS queue_ip_limit INT UNSIGNED NOT NULL DEFAULT 10;

-- Additive and retry-safe on MariaDB 10.6+. Existing migration checksums stay unchanged.
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_sent_at DATETIME(3) NULL;
ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS reference CHAR(8) CHARACTER SET ascii COLLATE ascii_bin NULL;
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN IF NOT EXISTS peer_ip VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS ip_source VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS actor_type VARCHAR(16) NULL,
  ADD COLUMN IF NOT EXISTS application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN IF NOT EXISTS api_key_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD INDEX IF NOT EXISTS idx_audit_request (request_id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS login_application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;

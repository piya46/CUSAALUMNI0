-- Existing credentials have no consent_id and will fail closed after this release.
-- Existing clients request profile/email by default, but users must approve sharing.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS allowed_claim_scopes VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'identity:read profile email',
 ADD COLUMN IF NOT EXISTS sharing_purpose VARCHAR(500) NOT NULL DEFAULT 'เข้าสู่ระบบและแสดงข้อมูลบัญชีใน Service นี้',
 ADD COLUMN IF NOT EXISTS sharing_version INT UNSIGNED NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS sso_consents (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
 application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 request_payload JSON NOT NULL,
 requested_scope VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 granted_scope VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
 policy_version INT UNSIGNED NOT NULL,
 notice_version VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 purpose VARCHAR(500) NOT NULL,
 mfa_method VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
 authenticated_at DATETIME(3) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 expires_at DATETIME(3) NOT NULL,
 decided_at DATETIME(3) NULL,
 revoked_at DATETIME(3) NULL,
 INDEX idx_consent_user (user_id,created_at,id),
 INDEX idx_consent_app (application_id,revoked_at),
 INDEX idx_consent_expiry (expires_at),
 FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
 FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE authorization_codes ADD COLUMN IF NOT EXISTS consent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS consent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;

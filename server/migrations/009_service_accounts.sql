-- Existing identities remain internal and continue to require the central allowlist.
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type ENUM('internal','service') NOT NULL DEFAULT 'internal';
CREATE INDEX IF NOT EXISTS idx_user_account_type ON users(account_type,deleted_at,created_at,id);
CREATE TABLE IF NOT EXISTS application_access_policies (
  application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  registration ENUM('closed','invite','open') NOT NULL DEFAULT 'closed',
  default_role_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  require_phone BOOLEAN NOT NULL DEFAULT FALSE,
  require_line BOOLEAN NOT NULL DEFAULT FALSE,
  minimum_mfa ENUM('standard','strong') NOT NULL DEFAULT 'standard',
  required_scopes VARCHAR(255) NOT NULL DEFAULT 'identity:read',
  registration_limit INT UNSIGNED NOT NULL DEFAULT 1000,
  pending_days INT UNSIGNED NOT NULL DEFAULT 14,
  inactive_days INT UNSIGNED NULL,
  notice_days INT UNSIGNED NOT NULL DEFAULT 30,
  recovery_days INT UNSIGNED NOT NULL DEFAULT 30,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  FOREIGN KEY (default_role_id) REFERENCES application_roles(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO application_access_policies(application_id) SELECT id FROM applications WHERE id NOT IN (SELECT application_id FROM application_access_policies);
ALTER TABLE application_memberships
  ADD COLUMN IF NOT EXISTS enrollment ENUM('pending','active') NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS source ENUM('admin','registration') NOT NULL DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS pending_until DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS last_activity_at DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS last_reported_activity_at DATETIME(3) NULL,
  ADD INDEX IF NOT EXISTS idx_member_inactivity(application_id,enrollment,revoked_at,last_activity_at,user_id),
  ADD INDEX IF NOT EXISTS idx_member_pending(pending_until);
CREATE INDEX IF NOT EXISTS idx_member_signup ON application_memberships(application_id,source,revoked_at);
CREATE TABLE IF NOT EXISTS application_invitations (
  application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email VARCHAR(254) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(application_id,email),
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  INDEX idx_invitation_expiry(expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS service_activity_receipts (
  application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY(application_id,event_id),
  FOREIGN KEY (application_id,user_id) REFERENCES application_memberships(application_id,user_id) ON DELETE CASCADE,
  INDEX idx_service_activity_expiry(expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- INVOKER never borrows the migration user's privileges. Only internal accounts
-- receive an allowlist role; service accounts cannot become administrators by email.
CREATE OR REPLACE SQL SECURITY INVOKER VIEW sso_login_accounts AS
 SELECT u.id,u.email,CASE WHEN u.account_type='internal' THEN a.role ELSE 'service' END AS role
 FROM users u LEFT JOIN allowed_emails a ON a.email=u.email
 WHERE u.deleted_at IS NULL AND (u.account_type='service' OR a.id IS NOT NULL);

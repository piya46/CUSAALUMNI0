-- All application datetimes are UTC. CREATE IF NOT EXISTS allows safe retry after interrupted DDL.
CREATE TABLE IF NOT EXISTS allowed_emails (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  role ENUM('admin','user') NOT NULL DEFAULT 'user',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_allowed_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  google_sub VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  email VARCHAR(254) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  avatar TEXT NULL,
  totp_secret TEXT NULL,
  totp_last_step BIGINT UNSIGNED NULL,
  mfa_failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  mfa_locked_until DATETIME(3) NULL,
  deleted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3) NULL,
  INDEX idx_users_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('pending','full') NOT NULL DEFAULT 'pending',
  csrf_token VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mfa_method ENUM('email','totp','recovery') NULL,
  authenticated_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  INDEX idx_sessions_expiry (expires_at),
  INDEX idx_sessions_user_kind_created (user_id, kind, created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oauth_flows (
  state_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  browser_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nonce VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  verifier TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  return_to TEXT NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  INDEX idx_oauth_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS otp_challenges (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  INDEX idx_otp_session (session_id, created_at),
  INDEX idx_otp_expiry (expires_at),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mfa_enrollments (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  secret TEXT NOT NULL,
  recovery_hashes JSON NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_recovery_user (user_id, used_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  hits INT UNSIGNED NOT NULL,
  reset_at DATETIME(3) NOT NULL,
  INDEX idx_rate_expiry (reset_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  actor_email VARCHAR(254) NULL,
  event VARCHAR(100) NOT NULL,
  status ENUM('success','failure') NOT NULL DEFAULT 'success',
  target VARCHAR(255) NULL,
  ip VARCHAR(64) NULL,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_agent VARCHAR(512) NULL,
  metadata JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id, created_at),
  INDEX idx_audit_created (created_at, id),
  INDEX idx_audit_actor (actor_id),
  INDEX idx_audit_email_created (actor_email, created_at),
  INDEX idx_audit_event_created (event, created_at),
  INDEX idx_audit_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_outbox (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_audit_outbox_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS applications (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  redirect_uri VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_keys (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(100) NOT NULL,
  prefix VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  scopes JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  last_used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  INDEX idx_keys_application (application_id),
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS authorization_codes (
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  redirect_uri VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  code_challenge VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  INDEX idx_code_expiry (expires_at),
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  INDEX idx_access_expiry (expires_at),
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

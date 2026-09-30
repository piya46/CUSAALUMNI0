-- Additive migration. Existing accounts are not forced into phone verification.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_required BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN IF NOT EXISTS line_sent_at DATETIME(3) NULL,
 ADD COLUMN IF NOT EXISTS phone_sent_at DATETIME(3) NULL;
ALTER TABLE sessions MODIFY mfa_method ENUM('email','totp','recovery','passkey','line') NULL;
CREATE TABLE IF NOT EXISTS passkeys (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 credential_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
 credential_id TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 public_key BLOB NOT NULL, counter BIGINT UNSIGNED NOT NULL DEFAULT 0,
 transports JSON NOT NULL, backed_up BOOLEAN NOT NULL, name VARCHAR(80) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), last_used_at DATETIME(3) NULL,
 INDEX idx_passkeys_user (user_id,created_at),
 FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS line_identities (
 user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 subject_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
 subject_encrypted TEXT NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS phone_identities (
 user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 phone_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
 phone_encrypted TEXT NOT NULL,
 firebase_uid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
 verified_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS factor_challenges (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 kind ENUM('passkey_register','passkey_auth','line_link','line_auth','phone') NOT NULL,
 payload TEXT NOT NULL,
 status ENUM('pending','approved','denied','used') NOT NULL DEFAULT 'pending',
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), expires_at DATETIME(3) NOT NULL,
 INDEX idx_factor_session (session_id,kind), INDEX idx_factor_expiry (expires_at),
 FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

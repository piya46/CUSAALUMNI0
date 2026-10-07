-- Session-bound refresh grants. Consumed digests remain until the family expires
-- so every old token can detect reuse; no plaintext credential is stored.
CREATE TABLE IF NOT EXISTS sso_refresh_families (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 api_key_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 consent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 scope VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 redirect_uri VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 expires_at DATETIME(3) NOT NULL,
 revoked_at DATETIME(3) NULL,
 INDEX idx_refresh_app_user (application_id,user_id),
 INDEX idx_refresh_app_session (application_id,session_id),
 INDEX idx_refresh_expiry (expires_at),
 FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
 FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
 FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
 FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
 FOREIGN KEY (consent_id) REFERENCES sso_consents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS refresh_tokens (
 token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 family_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 consumed_at DATETIME(3) NULL,
 INDEX idx_refresh_family (family_id),
 FOREIGN KEY (family_id) REFERENCES sso_refresh_families(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS refresh_family_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;
CREATE INDEX IF NOT EXISTS idx_access_refresh_family ON access_tokens(refresh_family_id);

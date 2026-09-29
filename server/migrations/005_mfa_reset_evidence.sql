CREATE TABLE IF NOT EXISTS mfa_reset_requests (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('uploading','pending','pending_second','approved','rejected','expired','cancelled') NOT NULL DEFAULT 'uploading',
  reason ENUM('lost','replaced','damaged') NOT NULL,
  notice_version VARCHAR(32) NOT NULL,
  factor_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  delete_after DATETIME(3) NOT NULL,
  evidence_ready_at DATETIME(3) NULL,
  first_approved_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  first_approved_at DATETIME(3) NULL,
  decided_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  decided_at DATETIME(3) NULL,
  decision_reason VARCHAR(40) NULL,
  purged_at DATETIME(3) NULL,
  INDEX idx_mfa_reset_user (user_id,created_at),
  INDEX idx_mfa_reset_status (status,created_at,id),
  INDEX idx_mfa_reset_purge (purged_at,delete_after)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mfa_reset_reviews (
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  admin_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  viewed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (request_id,admin_id),
  FOREIGN KEY (request_id) REFERENCES mfa_reset_requests(id) ON DELETE CASCADE
) ENGINE=InnoDB;

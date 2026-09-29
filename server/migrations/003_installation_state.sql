-- A completed installation is never reset by application code or subsequent migrations.
CREATE TABLE IF NOT EXISTS installation_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  completed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_installation_singleton CHECK (id = 1)
) ENGINE=InnoDB;

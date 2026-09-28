-- No automatic grants: existing users must explicitly be assigned to each service.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100) NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS application_roles (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_role_code (application_id, code),
  UNIQUE KEY uq_role_application (application_id, id),
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS application_memberships (
  application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  department VARCHAR(150) NOT NULL DEFAULT '',
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (application_id, user_id),
  KEY idx_membership_user (user_id, revoked_at),
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS application_member_roles (
  application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (application_id, user_id, role_id),
  KEY idx_member_role (application_id, role_id),
  KEY idx_member_user (user_id, application_id),
  FOREIGN KEY (application_id, user_id) REFERENCES application_memberships(application_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (application_id, role_id) REFERENCES application_roles(application_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

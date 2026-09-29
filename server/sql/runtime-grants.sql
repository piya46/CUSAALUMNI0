-- DBA template ONLY. Replace schema/account/host before execution.
-- Use a NEW account with no global/schema grants. Adding narrow grants never
-- removes privileges previously granted by Plesk at database level.
-- Account creation and passwords are managed by your DBA/secret manager.
-- Embedded audit worker shares this runtime account.
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`application_roles` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`application_memberships` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`application_member_roles` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`allowed_emails` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`users` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`sessions` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`oauth_flows` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`otp_challenges` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`mfa_enrollments` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`mfa_recovery_codes` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`rate_limits` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`applications` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`api_keys` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`authorization_codes` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`access_tokens` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`mfa_reset_requests` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `scicualu_alumni`.`mfa_reset_reviews` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT ON `scicualu_alumni`.`audit_logs` TO 'cusa_runtime'@'localhost';
GRANT SELECT, INSERT, DELETE ON `scicualu_alumni`.`audit_outbox` TO 'cusa_runtime'@'localhost';
GRANT SELECT ON `scicualu_alumni`.`installation_state` TO 'cusa_runtime'@'localhost';
GRANT SELECT ON `scicualu_alumni`.`schema_migrations` TO 'cusa_runtime'@'localhost';

-- Separate account for exporting archives; does not modify audit data.
GRANT SELECT ON `scicualu_alumni`.`audit_logs` TO 'cusa_audit_reader'@'localhost';
GRANT SELECT ON `scicualu_alumni`.`audit_outbox` TO 'cusa_audit_reader'@'localhost';
-- Verify effective SHOW GRANTS and role inheritance. Never grant runtime
-- GRANT OPTION, FILE, SUPER, CREATE, ALTER, DROP, TRIGGER or schema-wide DML.

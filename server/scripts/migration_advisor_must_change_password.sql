-- ============================================================================
-- BMU AI Academic Advisor — admin-create user + force-change-on-first-login
--
-- Adds:
--   * users.must_change_password BOOLEAN DEFAULT 0
--     → set to 1 when an admin creates an account by hand. The login flow
--       returns this flag in the auth payload, and the client routes the
--       user to a /change-password page before unlocking the rest of the
--       app. Cleared as soon as the password is updated.
--
-- Idempotent — guarded with information_schema lookups.
-- ============================================================================

SET @dbname = DATABASE();

SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = @dbname AND table_name = 'users' AND column_name = 'must_change_password') = 0,
    'ALTER TABLE users ADD COLUMN must_change_password BOOLEAN DEFAULT 0 AFTER password',
    'SELECT "Column must_change_password already exists"'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'must_change_password migration complete' AS status;

-- ============================================================================
-- BMU AI Academic Advisor — daily prompt limits + matric capture
--
-- Adds:
--   * users.daily_prompt_limit  / daily_prompt_count / daily_prompt_reset
--     → enforces a per-day cap on advisor chats (default 10/day for staff,
--       unlimited (-1) for admin/superadmin).
--   * users.matric_no
--     → optional matric number captured at registration so the advisor can
--       personalise replies and link to the existing students table.
--
-- All ALTERs guarded with information_schema lookups so the migration is
-- idempotent.
-- ============================================================================

-- ----- daily_prompt_limit -----------------------------------------------------
SET @dbname = DATABASE();
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = @dbname AND table_name = 'users' AND column_name = 'daily_prompt_limit') = 0,
    'ALTER TABLE users ADD COLUMN daily_prompt_limit INT DEFAULT 10 AFTER monthly_prompt_limit',
    'SELECT "Column daily_prompt_limit already exists"'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ----- daily_prompt_count ----------------------------------------------------
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = @dbname AND table_name = 'users' AND column_name = 'daily_prompt_count') = 0,
    'ALTER TABLE users ADD COLUMN daily_prompt_count INT DEFAULT 0 AFTER daily_prompt_limit',
    'SELECT "Column daily_prompt_count already exists"'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ----- daily_prompt_reset ----------------------------------------------------
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = @dbname AND table_name = 'users' AND column_name = 'daily_prompt_reset') = 0,
    'ALTER TABLE users ADD COLUMN daily_prompt_reset DATE DEFAULT NULL AFTER daily_prompt_count',
    'SELECT "Column daily_prompt_reset already exists"'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ----- matric_no (optional) --------------------------------------------------
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = @dbname AND table_name = 'users' AND column_name = 'matric_no') = 0,
    'ALTER TABLE users ADD COLUMN matric_no VARCHAR(40) NULL AFTER department',
    'SELECT "Column matric_no already exists"'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ----- Set baseline values --------------------------------------------------

-- Bump every staff user to the new defaults the deployment will use:
--   100 prompts / month, 10 prompts / day.
UPDATE users SET monthly_prompt_limit = 100 WHERE role = 'staff' AND monthly_prompt_limit < 100;
UPDATE users SET daily_prompt_limit   = 10  WHERE role = 'staff' AND (daily_prompt_limit IS NULL OR daily_prompt_limit = 0);
UPDATE users SET daily_prompt_count   = 0   WHERE daily_prompt_count IS NULL;

-- Admins / superadmins are unlimited.
UPDATE users SET daily_prompt_limit = -1 WHERE role IN ('admin', 'superadmin');

-- Default-system-setting hints (informational only).
INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, description)
VALUES ('default_daily_prompt_limit', '10', 'number', 'Default daily prompt limit for staff/student users');

INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, description)
VALUES ('default_monthly_prompt_limit_v2', '100', 'number', 'Default monthly prompt limit for staff/student users (raised from 30)');

SELECT 'Daily limit + matric migration complete' AS status;

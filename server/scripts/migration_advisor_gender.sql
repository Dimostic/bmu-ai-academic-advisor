-- ============================================================================
-- BMU AI Academic Advisor — advisor avatar / voice gender preference
--
-- Adds:
--   * users.advisor_gender ENUM('female','male') DEFAULT 'female'
--     → drives both the on-screen avatar image and the TTS voice id sent
--       to TTSMaker. Default 'female' matches the existing Dr. Tari
--       persona so unchanged accounts keep the same voice they're used to.
--
-- Idempotent — guarded with information_schema.
-- ============================================================================

SET @dbname = DATABASE();

SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = @dbname AND table_name = 'users' AND column_name = 'advisor_gender') = 0,
    'ALTER TABLE users ADD COLUMN advisor_gender ENUM(''female'',''male'') DEFAULT ''female'' AFTER department',
    'SELECT "Column advisor_gender already exists"'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'advisor_gender migration complete' AS status;

-- filepath: /Applications/MAMP/htdocs/bmucia-agent/server/scripts/migration_usage_limits.sql
-- Migration: User Usage Limits and Token Tracking
-- Created: 2026-01-04
-- Purpose: Add monthly prompt limits, token tracking per user/model

-- =====================================================
-- 1. User Monthly Usage Tracking - Add columns to users
-- =====================================================
-- Note: Run these one at a time if column already exists errors occur

-- Check if columns exist before adding (MySQL 8.0+ approach)
SET @dbname = DATABASE();

-- Add monthly_prompt_count column
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'users' AND COLUMN_NAME = 'monthly_prompt_count') = 0,
    'ALTER TABLE users ADD COLUMN monthly_prompt_count INT DEFAULT 0',
    'SELECT "Column monthly_prompt_count already exists"'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add monthly_prompt_reset column  
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'users' AND COLUMN_NAME = 'monthly_prompt_reset') = 0,
    'ALTER TABLE users ADD COLUMN monthly_prompt_reset DATE DEFAULT NULL',
    'SELECT "Column monthly_prompt_reset already exists"'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add monthly_prompt_limit column
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'users' AND COLUMN_NAME = 'monthly_prompt_limit') = 0,
    'ALTER TABLE users ADD COLUMN monthly_prompt_limit INT DEFAULT 30',
    'SELECT "Column monthly_prompt_limit already exists"'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- =====================================================
-- 2. Token Usage Tracking Table
-- =====================================================

CREATE TABLE IF NOT EXISTS usage_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    chat_message_id INT DEFAULT NULL,
    model_id VARCHAR(100) NOT NULL,
    prompt_tokens INT DEFAULT 0,
    completion_tokens INT DEFAULT 0,
    total_tokens INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    month_year VARCHAR(7) DEFAULT NULL,
    INDEX idx_usage_user (user_id),
    INDEX idx_usage_model (model_id),
    INDEX idx_usage_month (month_year),
    INDEX idx_usage_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================
-- 3. Monthly Usage Summary Table
-- =====================================================

CREATE TABLE IF NOT EXISTS monthly_usage_summary (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    model_id VARCHAR(100) NOT NULL,
    month_year VARCHAR(7) NOT NULL,
    prompt_count INT DEFAULT 0,
    total_tokens INT DEFAULT 0,
    prompt_tokens INT DEFAULT 0,
    completion_tokens INT DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_model_month (user_id, model_id, month_year),
    INDEX idx_summary_month (month_year),
    INDEX idx_summary_model (model_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================
-- 4. Insert Default System Settings
-- =====================================================

INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, description)
VALUES ('default_monthly_prompt_limit', '30', 'number', 'Default monthly prompt limit for staff users');

INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, description)
VALUES ('admin_monthly_prompt_limit', '-1', 'number', 'Monthly prompt limit for admin users (-1 = unlimited)');

INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, description)
VALUES ('superadmin_monthly_prompt_limit', '-1', 'number', 'Monthly prompt limit for superadmin users (-1 = unlimited)');

-- =====================================================
-- 5. Update existing users with default limits
-- =====================================================

UPDATE users SET monthly_prompt_limit = -1 WHERE role IN ('admin', 'superadmin') AND monthly_prompt_limit IS NULL;
UPDATE users SET monthly_prompt_limit = 30 WHERE role = 'staff' AND monthly_prompt_limit IS NULL;
UPDATE users SET monthly_prompt_count = 0 WHERE monthly_prompt_count IS NULL;
UPDATE users SET monthly_prompt_reset = CURDATE() WHERE monthly_prompt_reset IS NULL;

-- =====================================================
-- 6. Create Analytics Views
-- =====================================================

-- View: Token usage by model (current month)
DROP VIEW IF EXISTS v_current_month_model_usage;
CREATE VIEW v_current_month_model_usage AS
SELECT 
    model_id,
    COUNT(*) AS request_count,
    SUM(prompt_tokens) AS total_prompt_tokens,
    SUM(completion_tokens) AS total_completion_tokens,
    SUM(total_tokens) AS total_tokens
FROM usage_logs
WHERE month_year = DATE_FORMAT(NOW(), '%Y-%m')
GROUP BY model_id;

-- View: Token usage by user (current month)
DROP VIEW IF EXISTS v_current_month_user_usage;
CREATE VIEW v_current_month_user_usage AS
SELECT 
    u.id AS user_id,
    u.email,
    CONCAT(u.first_name, ' ', u.last_name) AS user_name,
    u.role,
    u.monthly_prompt_count,
    u.monthly_prompt_limit,
    COALESCE(SUM(ul.total_tokens), 0) AS total_tokens_used,
    COUNT(ul.id) AS total_requests
FROM users u
LEFT JOIN usage_logs ul ON u.id = ul.user_id AND ul.month_year = DATE_FORMAT(NOW(), '%Y-%m')
GROUP BY u.id, u.email, u.first_name, u.last_name, u.role, u.monthly_prompt_count, u.monthly_prompt_limit;

-- Done!
SELECT 'Migration completed successfully!' AS status;

-- Migration: Add email verification and admin approval columns to users table
-- Run this migration on the production database
-- Note: MariaDB/MySQL doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
-- So we use stored procedure to check if column exists first

DELIMITER //

-- Helper procedure to add column if not exists
DROP PROCEDURE IF EXISTS add_column_if_not_exists//
CREATE PROCEDURE add_column_if_not_exists()
BEGIN
    -- Add is_approved column
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_approved') THEN
        ALTER TABLE users ADD COLUMN is_approved BOOLEAN DEFAULT FALSE AFTER is_verified;
    END IF;
    
    -- Add verification_token_expires column
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'verification_token_expires') THEN
        ALTER TABLE users ADD COLUMN verification_token_expires DATETIME AFTER verification_token;
    END IF;
    
    -- Add approved_by column
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'approved_by') THEN
        ALTER TABLE users ADD COLUMN approved_by INT AFTER is_approved;
    END IF;
    
    -- Add approved_at column
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'approved_at') THEN
        ALTER TABLE users ADD COLUMN approved_at DATETIME AFTER approved_by;
    END IF;
END//

DELIMITER ;

-- Run the procedure
CALL add_column_if_not_exists();

-- Clean up
DROP PROCEDURE IF EXISTS add_column_if_not_exists;

-- For existing users who are already active, mark them as verified and approved
-- This ensures existing users can still log in
UPDATE users SET is_verified = TRUE, is_approved = TRUE WHERE is_active = TRUE AND (is_verified = FALSE OR is_approved = FALSE);

-- Set existing superadmins as verified and approved
UPDATE users SET is_verified = TRUE, is_approved = TRUE WHERE role = 'superadmin';

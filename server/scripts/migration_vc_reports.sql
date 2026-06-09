-- VC Reports System Migration Script
-- Run this script to create the necessary tables for the VC Reports feature
-- This feature allows the Vice Chancellor to view, analyze, and chat with submitted reports

-- Table: vc_reports
-- Stores all reports submitted to the VC
CREATE TABLE IF NOT EXISTS vc_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    category ENUM(
        'academic_affairs',
        'administrative',
        'financial',
        'security',
        'student_affairs',
        'staff_welfare',
        'senate',
        'infrastructure',
        'research',
        'community_service',
        'compliance_audit',
        'strategic_planning',
        'other'
    ) NOT NULL DEFAULT 'other',
    file_name VARCHAR(500) NOT NULL,
    file_path VARCHAR(1000) NOT NULL,
    file_type VARCHAR(50) NOT NULL,
    file_size BIGINT NOT NULL,
    
    -- Report metadata
    submitted_by INT NOT NULL,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    report_date DATE,
    department VARCHAR(255),
    
    -- Processing status
    processing_status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
    chunks_count INT DEFAULT 0,
    
    -- AI Analysis fields (generated after processing)
    ai_summary TEXT,
    ai_key_points JSON,
    ai_concerns JSON,
    ai_highlights JSON,
    ai_recommendations JSON,
    ai_sentiment ENUM('positive', 'neutral', 'negative', 'mixed') DEFAULT 'neutral',
    ai_analyzed_at DATETIME,
    
    -- Status and tracking
    is_read BOOLEAN DEFAULT FALSE,
    read_at DATETIME,
    is_starred BOOLEAN DEFAULT FALSE,
    is_archived BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Foreign keys
    FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE RESTRICT,
    
    -- Indexes for performance
    INDEX idx_category (category),
    INDEX idx_submitted_by (submitted_by),
    INDEX idx_submitted_at (submitted_at),
    INDEX idx_processing_status (processing_status),
    INDEX idx_is_read (is_read),
    INDEX idx_is_starred (is_starred),
    INDEX idx_is_archived (is_archived),
    INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: vc_report_chunks
-- Stores chunked content for AI retrieval (similar to document_chunks)
CREATE TABLE IF NOT EXISTS vc_report_chunks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    report_id INT NOT NULL,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    embedding JSON,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign keys
    FOREIGN KEY (report_id) REFERENCES vc_reports(id) ON DELETE CASCADE,
    
    -- Unique constraint
    UNIQUE KEY uk_report_chunk (report_id, chunk_index),
    
    -- Indexes
    INDEX idx_report_id (report_id),
    INDEX idx_chunk_index (chunk_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: vc_report_notes
-- Stores VC's personal notes on reports
CREATE TABLE IF NOT EXISTS vc_report_notes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    report_id INT NOT NULL,
    user_id INT NOT NULL,
    note_text TEXT NOT NULL,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Foreign keys
    FOREIGN KEY (report_id) REFERENCES vc_reports(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    
    -- Indexes
    INDEX idx_report_id (report_id),
    INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: vc_report_chat_sessions
-- Stores chat sessions for report-specific conversations
CREATE TABLE IF NOT EXISTS vc_report_chat_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    report_id INT NOT NULL,
    user_id INT NOT NULL,
    session_token VARCHAR(255) NOT NULL UNIQUE,
    title VARCHAR(255),
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Foreign keys
    FOREIGN KEY (report_id) REFERENCES vc_reports(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    
    -- Indexes
    INDEX idx_report_id (report_id),
    INDEX idx_user_id (user_id),
    INDEX idx_session_token (session_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: vc_report_chat_messages
-- Stores chat messages for report conversations
CREATE TABLE IF NOT EXISTS vc_report_chat_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    role ENUM('user', 'assistant') NOT NULL,
    content TEXT NOT NULL,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign keys
    FOREIGN KEY (session_id) REFERENCES vc_report_chat_sessions(id) ON DELETE CASCADE,
    
    -- Indexes
    INDEX idx_session_id (session_id),
    INDEX idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add vc_reports_access column to users table if it doesn't exist
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS vc_reports_access BOOLEAN DEFAULT FALSE 
AFTER monthly_prompt_count;

-- Grant VC reports access to superadmin users by default
UPDATE users SET vc_reports_access = TRUE WHERE role = 'superadmin';

-- Create a view for easy report retrieval with submitter info
CREATE OR REPLACE VIEW vw_vc_reports AS
SELECT 
    r.*,
    u.email AS submitted_by_email,
    u.first_name AS submitted_by_first_name,
    u.last_name AS submitted_by_last_name,
    u.department AS submitted_by_department,
    CONCAT(u.first_name, ' ', u.last_name) AS submitted_by_name
FROM vc_reports r
LEFT JOIN users u ON r.submitted_by = u.id
WHERE r.is_active = TRUE;

-- Insert sample category descriptions (optional - for UI reference)
-- These are the report categories:
-- academic_affairs: Academic programs, curriculum, examinations, accreditation
-- administrative: General admin, office operations, policies, procedures
-- financial: Budget, expenditure, revenue, financial statements
-- security: Campus security, incidents, safety measures
-- student_affairs: Student welfare, activities, disciplinary matters
-- staff_welfare: Staff matters, welfare, training, development
-- senate: Senate meetings, decisions, academic governance
-- infrastructure: Buildings, facilities, maintenance, projects
-- research: Research activities, grants, publications
-- community_service: Outreach programs, community engagement
-- compliance_audit: Compliance reports, audit findings, recommendations
-- strategic_planning: Strategic initiatives, planning, development
-- other: Reports that don't fit other categories

DELIMITER //

-- Stored procedure to get report statistics
CREATE PROCEDURE IF NOT EXISTS sp_get_vc_report_stats()
BEGIN
    SELECT 
        COUNT(*) as total_reports,
        SUM(CASE WHEN is_read = FALSE THEN 1 ELSE 0 END) as unread_count,
        SUM(CASE WHEN is_starred = TRUE THEN 1 ELSE 0 END) as starred_count,
        SUM(CASE WHEN processing_status = 'completed' THEN 1 ELSE 0 END) as processed_count,
        SUM(CASE WHEN processing_status = 'pending' OR processing_status = 'processing' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN ai_sentiment = 'positive' THEN 1 ELSE 0 END) as positive_sentiment_count,
        SUM(CASE WHEN ai_sentiment = 'negative' THEN 1 ELSE 0 END) as negative_sentiment_count,
        SUM(CASE WHEN ai_sentiment = 'neutral' THEN 1 ELSE 0 END) as neutral_sentiment_count,
        SUM(CASE WHEN ai_sentiment = 'mixed' THEN 1 ELSE 0 END) as mixed_sentiment_count
    FROM vc_reports
    WHERE is_active = TRUE AND is_archived = FALSE;
END //

-- Stored procedure to get category breakdown
CREATE PROCEDURE IF NOT EXISTS sp_get_vc_report_category_stats()
BEGIN
    SELECT 
        category,
        COUNT(*) as count,
        SUM(CASE WHEN is_read = FALSE THEN 1 ELSE 0 END) as unread_count
    FROM vc_reports
    WHERE is_active = TRUE AND is_archived = FALSE
    GROUP BY category
    ORDER BY count DESC;
END //

DELIMITER ;

-- Grant execute permissions (adjust as needed for your MySQL user)
-- GRANT EXECUTE ON PROCEDURE bmu_ai_agent.sp_get_vc_report_stats TO 'your_user'@'localhost';
-- GRANT EXECUTE ON PROCEDURE bmu_ai_agent.sp_get_vc_report_category_stats TO 'your_user'@'localhost';

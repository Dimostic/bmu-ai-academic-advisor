-- VC Documents System Migration Script
-- Run this script to create the necessary tables for the VC Documents feature
-- This feature allows the Vice Chancellor to view, analyze, and chat with uploaded documents

-- Table: vc_documents
-- Stores all documents submitted to the VC
CREATE TABLE IF NOT EXISTS vc_documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    category ENUM(
        'policy',
        'regulation',
        'memo',
        'circular',
        'directive',
        'agreement',
        'minutes',
        'budget',
        'audit',
        'strategy',
        'research',
        'compliance',
        'operations',
        'other'
    ) NOT NULL DEFAULT 'other',
    file_name VARCHAR(500) NOT NULL,
    file_path VARCHAR(1000) NOT NULL,
    file_type VARCHAR(50) NOT NULL,
    file_size BIGINT NOT NULL,
    
    -- Document metadata
    uploaded_by INT NOT NULL,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    document_date DATE,
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
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE RESTRICT,
    
    -- Indexes for performance
    INDEX idx_category (category),
    INDEX idx_uploaded_by (uploaded_by),
    INDEX idx_uploaded_at (uploaded_at),
    INDEX idx_processing_status (processing_status),
    INDEX idx_is_read (is_read),
    INDEX idx_is_starred (is_starred),
    INDEX idx_is_archived (is_archived),
    INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: vc_document_chunks
-- Stores chunked content for AI retrieval (similar to document_chunks)
CREATE TABLE IF NOT EXISTS vc_document_chunks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    document_id INT NOT NULL,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    embedding JSON,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign keys
    FOREIGN KEY (document_id) REFERENCES vc_documents(id) ON DELETE CASCADE,
    
    -- Unique constraint
    UNIQUE KEY uk_document_chunk (document_id, chunk_index),
    
    -- Indexes
    INDEX idx_document_id (document_id),
    INDEX idx_chunk_index (chunk_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: vc_document_notes
-- Stores VC's personal notes on documents
CREATE TABLE IF NOT EXISTS vc_document_notes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    document_id INT NOT NULL,
    user_id INT NOT NULL,
    note_text TEXT NOT NULL,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Foreign keys
    FOREIGN KEY (document_id) REFERENCES vc_documents(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    
    -- Indexes
    INDEX idx_document_id (document_id),
    INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: vc_document_chat_sessions
-- Stores chat sessions for document-specific conversations
CREATE TABLE IF NOT EXISTS vc_document_chat_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    document_id INT NOT NULL,
    user_id INT NOT NULL,
    session_token VARCHAR(255) NOT NULL UNIQUE,
    title VARCHAR(255),
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Foreign keys
    FOREIGN KEY (document_id) REFERENCES vc_documents(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    
    -- Indexes
    INDEX idx_document_id (document_id),
    INDEX idx_user_id (user_id),
    INDEX idx_session_token (session_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: vc_document_chat_messages
-- Stores chat messages for document conversations
CREATE TABLE IF NOT EXISTS vc_document_chat_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    role ENUM('user', 'assistant') NOT NULL,
    content TEXT NOT NULL,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign keys
    FOREIGN KEY (session_id) REFERENCES vc_document_chat_sessions(id) ON DELETE CASCADE,
    
    -- Indexes
    INDEX idx_session_id (session_id),
    INDEX idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add vc_documents_access column to users table if it doesn't exist
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS vc_documents_access BOOLEAN DEFAULT FALSE 
AFTER monthly_prompt_count;

-- Grant VC documents access to superadmin users by default
UPDATE users SET vc_documents_access = TRUE WHERE role = 'superadmin';

-- Create a view for easy document retrieval with submitter info
CREATE OR REPLACE VIEW vw_vc_documents AS
SELECT 
    r.*,
    u.email AS uploaded_by_email,
    u.first_name AS uploaded_by_first_name,
    u.last_name AS uploaded_by_last_name,
    u.department AS uploaded_by_department,
    CONCAT(u.first_name, ' ', u.last_name) AS uploaded_by_name
FROM vc_documents r
LEFT JOIN users u ON r.uploaded_by = u.id
WHERE r.is_active = TRUE;

-- Insert sample category descriptions (optional - for UI reference)
-- These are the document categories:
-- policy: Policies, guidelines, and official rules
-- regulation: Statutory or regulatory documents
-- memo: Internal memos and briefs
-- circular: Circulars and notices
-- directive: Executive directives and orders
-- agreement: Contracts, MoUs, and agreements
-- minutes: Meeting minutes and resolutions
-- budget: Budget, finance, and expenditure documents
-- audit: Audit findings and financial reviews
-- strategy: Strategic plans and roadmaps
-- research: Research reports and publications
-- compliance: Compliance documents and checklists
-- operations: Operational procedures and SOPs
-- other: Documents that don't fit other categories

DELIMITER //

-- Stored procedure to get document statistics
CREATE PROCEDURE IF NOT EXISTS sp_get_vc_document_stats()
BEGIN
    SELECT 
        COUNT(*) as total_documents,
        SUM(CASE WHEN is_read = FALSE THEN 1 ELSE 0 END) as unread_count,
        SUM(CASE WHEN is_starred = TRUE THEN 1 ELSE 0 END) as starred_count,
        SUM(CASE WHEN processing_status = 'completed' THEN 1 ELSE 0 END) as processed_count,
        SUM(CASE WHEN processing_status = 'pending' OR processing_status = 'processing' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN ai_sentiment = 'positive' THEN 1 ELSE 0 END) as positive_sentiment_count,
        SUM(CASE WHEN ai_sentiment = 'negative' THEN 1 ELSE 0 END) as negative_sentiment_count,
        SUM(CASE WHEN ai_sentiment = 'neutral' THEN 1 ELSE 0 END) as neutral_sentiment_count,
        SUM(CASE WHEN ai_sentiment = 'mixed' THEN 1 ELSE 0 END) as mixed_sentiment_count
    FROM vc_documents
    WHERE is_active = TRUE AND is_archived = FALSE;
END //

-- Stored procedure to get category breakdown
CREATE PROCEDURE IF NOT EXISTS sp_get_vc_document_category_stats()
BEGIN
    SELECT 
        category,
        COUNT(*) as count,
        SUM(CASE WHEN is_read = FALSE THEN 1 ELSE 0 END) as unread_count
    FROM vc_documents
    WHERE is_active = TRUE AND is_archived = FALSE
    GROUP BY category
    ORDER BY count DESC;
END //

DELIMITER ;

-- Grant execute permissions (adjust as needed for your MySQL user)
-- GRANT EXECUTE ON PROCEDURE bmu_ai_agent.sp_get_vc_document_stats TO 'your_user'@'localhost';
-- GRANT EXECUTE ON PROCEDURE bmu_ai_agent.sp_get_vc_document_category_stats TO 'your_user'@'localhost';

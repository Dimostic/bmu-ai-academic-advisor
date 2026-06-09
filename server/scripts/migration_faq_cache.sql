-- Migration: FAQ/Q&A Caching System for Performance Optimization
-- This creates tables to store pre-generated Q&A pairs and cached responses

USE bmu_ai_agent;

-- ===================== FAQ Categories =====================
-- Categories to organize FAQs by topic/document type
CREATE TABLE IF NOT EXISTS faq_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon VARCHAR(50) DEFAULT 'fas fa-folder',
    display_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_category_name (name),
    INDEX idx_active_order (is_active, display_order)
) ENGINE=InnoDB;

-- ===================== Cached Q&A Pairs =====================
-- Pre-generated questions and answers from document analysis
CREATE TABLE IF NOT EXISTS cached_qa (
    id INT AUTO_INCREMENT PRIMARY KEY,
    document_id INT,
    category_id INT,
    question TEXT NOT NULL,
    question_variations JSON,  -- Array of alternative phrasings
    answer TEXT NOT NULL,
    answer_sources JSON,       -- References to document sections
    embedding MEDIUMTEXT,      -- Question embedding for similarity search
    confidence_score DECIMAL(3,2) DEFAULT 1.00,  -- How confident we are in this answer
    usage_count INT DEFAULT 0,
    last_used_at DATETIME,
    is_verified BOOLEAN DEFAULT FALSE,  -- Admin verified accuracy
    verified_by INT,
    verified_at DATETIME,
    is_active BOOLEAN DEFAULT TRUE,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_cached_qa_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL,
    CONSTRAINT fk_cached_qa_category FOREIGN KEY (category_id) REFERENCES faq_categories(id) ON DELETE SET NULL,
    CONSTRAINT fk_cached_qa_verified_by FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_cached_qa_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_document_id (document_id),
    INDEX idx_category_id (category_id),
    INDEX idx_active (is_active),
    INDEX idx_usage (usage_count DESC),
    FULLTEXT INDEX ft_question (question)
) ENGINE=InnoDB;

-- ===================== Q&A Cache Hits Log =====================
-- Track when cached answers are used (for analytics and improvement)
CREATE TABLE IF NOT EXISTS qa_cache_hits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cached_qa_id INT NOT NULL,
    user_id INT,
    session_id INT,
    user_query TEXT NOT NULL,          -- Original user question
    similarity_score DECIMAL(4,3),     -- How similar was the match
    response_time_ms INT,              -- How fast we returned the answer
    was_helpful BOOLEAN,               -- User feedback (optional)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_cache_hit_qa FOREIGN KEY (cached_qa_id) REFERENCES cached_qa(id) ON DELETE CASCADE,
    CONSTRAINT fk_cache_hit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_cache_hit_session FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL,
    INDEX idx_cached_qa_id (cached_qa_id),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB;

-- ===================== Q&A Generation Jobs =====================
-- Track document Q&A generation status
CREATE TABLE IF NOT EXISTS qa_generation_jobs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    document_id INT NOT NULL,
    status ENUM('queued', 'processing', 'completed', 'failed') DEFAULT 'queued',
    questions_generated INT DEFAULT 0,
    progress INT DEFAULT 0,
    error_message TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    initiated_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_qa_job_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    CONSTRAINT fk_qa_job_initiated_by FOREIGN KEY (initiated_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_document_id (document_id),
    INDEX idx_status (status)
) ENGINE=InnoDB;

-- ===================== Insert Default Categories =====================
INSERT INTO faq_categories (name, description, icon, display_order) VALUES
('Academic Policies', 'Questions about academic regulations, grading, examinations', 'fas fa-graduation-cap', 1),
('Administrative Procedures', 'Administrative processes, forms, and requirements', 'fas fa-clipboard-list', 2),
('Student Affairs', 'Student life, conduct, welfare, and support services', 'fas fa-users', 3),
('Staff & HR', 'Staff policies, employment, benefits, and procedures', 'fas fa-id-badge', 4),
('Financial Matters', 'Fees, payments, scholarships, and financial aid', 'fas fa-money-bill', 5),
('Facilities & Resources', 'Campus facilities, library, IT services', 'fas fa-building', 6),
('Research & Publications', 'Research policies, ethics, and publication guidelines', 'fas fa-flask', 7),
('General Information', 'General university information and FAQs', 'fas fa-info-circle', 8)
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

-- ===================== System Settings for FAQ =====================
INSERT INTO system_settings (setting_key, setting_value, setting_type, description, is_public) VALUES
('faq_cache_enabled', 'true', 'boolean', 'Enable FAQ/Q&A caching for faster responses', FALSE),
('faq_similarity_threshold', '0.75', 'number', 'Minimum similarity score to use cached answer (0-1)', FALSE),
('faq_max_questions_per_doc', '50', 'number', 'Maximum Q&A pairs to generate per document', FALSE),
('faq_auto_generate', 'false', 'boolean', 'Automatically generate Q&A when documents are uploaded', FALSE)
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

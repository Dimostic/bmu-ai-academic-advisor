-- BMU AI Academic Advisor - Database Setup Script
-- Bayelsa Medical University

-- Create database
CREATE DATABASE IF NOT EXISTS bmu_academic_advisor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE bmu_academic_advisor;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    phone VARCHAR(20),
    department VARCHAR(100),
    role ENUM('staff', 'admin', 'superadmin') DEFAULT 'staff',
    is_verified BOOLEAN DEFAULT FALSE,
    is_approved BOOLEAN DEFAULT FALSE,
    verification_token VARCHAR(255),
    verification_token_expires DATETIME,
    approved_by INT,
    approved_at DATETIME,
    reset_token VARCHAR(255),
    reset_token_expires DATETIME,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_email (email),
    INDEX idx_role (role),
    INDEX idx_verification_token (verification_token),
    INDEX idx_is_verified (is_verified),
    INDEX idx_is_approved (is_approved)
) ENGINE=InnoDB;

-- Documents table for training materials
CREATE TABLE IF NOT EXISTS documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    file_type VARCHAR(50) NOT NULL,
    file_size INT,
    category ENUM('policy', 'regulation', 'academic', 'administrative', 'legal', 'general') DEFAULT 'general',
    tags JSON,
    content_text LONGTEXT,
    embedding_status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
    embedding_id VARCHAR(255),
    uploaded_by INT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_documents_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_category (category),
    INDEX idx_embedding_status (embedding_status),
    FULLTEXT INDEX ft_content (title, description, content_text)
) ENGINE=InnoDB;

-- ===================== RAG Vector Store =====================
-- Chunked content + embeddings for retrieval-augmented generation.
CREATE TABLE IF NOT EXISTS document_chunks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    document_id INT NOT NULL,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    embedding MEDIUMTEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_document_id (document_id),
    UNIQUE KEY uniq_doc_chunk (document_id, chunk_index),
    CONSTRAINT fk_document_chunks_document
        FOREIGN KEY (document_id) REFERENCES documents(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;

-- Chat sessions table
CREATE TABLE IF NOT EXISTS chat_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    session_token VARCHAR(255) UNIQUE NOT NULL,
    platform ENUM('web', 'api') DEFAULT 'web',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_chat_sessions_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_session_token (session_token),
    INDEX idx_user_id (user_id)
) ENGINE=InnoDB;

-- Chat messages table
CREATE TABLE IF NOT EXISTS chat_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    user_id INT,
    message_type ENUM('text', 'audio', 'file') DEFAULT 'text',
    sender ENUM('user', 'assistant') NOT NULL,
    content TEXT NOT NULL,
    audio_url VARCHAR(500),
    tokens_used INT DEFAULT 0,
    response_time_ms INT,
    referenced_documents JSON,
    feedback_rating TINYINT,
    feedback_comment TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_chat_messages_session_id FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_messages_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_session_id (session_id),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB;

-- Document training jobs
CREATE TABLE IF NOT EXISTS training_jobs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    document_id INT,
    status ENUM('queued', 'processing', 'completed', 'failed') DEFAULT 'queued',
    progress INT DEFAULT 0,
    error_message TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    initiated_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (initiated_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_status (status)
) ENGINE=InnoDB;

-- Audit trail table
CREATE TABLE IF NOT EXISTS audit_trail (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id INT,
    details JSON,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_audit_trail_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_user_id (user_id),
    INDEX idx_action (action),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB;

-- System settings table
CREATE TABLE IF NOT EXISTS system_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value TEXT,
    setting_type ENUM('string', 'number', 'boolean', 'json') DEFAULT 'string',
    description TEXT,
    is_public BOOLEAN DEFAULT FALSE,
    updated_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- WhatsApp verification codes (DEPRECATED: web-only)
-- NOTE: keeping table definition commented out to avoid confusion and syntax issues on fresh deploy.
-- If you still need WhatsApp, uncomment.
-- CREATE TABLE IF NOT EXISTS whatsapp_verifications (
--     id INT AUTO_INCREMENT PRIMARY KEY,
--     user_id INT NOT NULL,
--     phone_number VARCHAR(20) NOT NULL,
--     verification_code VARCHAR(6) NOT NULL,
--     expires_at DATETIME NOT NULL,
--     verified BOOLEAN DEFAULT FALSE,
--     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--     CONSTRAINT fk_whatsapp_verifications_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
--     INDEX idx_phone (phone_number),
--     INDEX idx_code (verification_code)
-- ) ENGINE=InnoDB;

-- API keys for external integrations
CREATE TABLE IF NOT EXISTS api_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    key_name VARCHAR(100) NOT NULL,
    api_key VARCHAR(255) UNIQUE NOT NULL,
    permissions JSON,
    last_used DATETIME,
    expires_at DATETIME,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_api_key (api_key)
) ENGINE=InnoDB;

-- Export requests table
CREATE TABLE IF NOT EXISTS export_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    export_type ENUM('chat_history', 'documents', 'users', 'audit_trail', 'analytics') NOT NULL,
    format ENUM('csv', 'json', 'pdf', 'xlsx') DEFAULT 'csv',
    filters JSON,
    file_path VARCHAR(500),
    status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_status (status)
) ENGINE=InnoDB;

-- Insert default system settings
INSERT INTO system_settings (setting_key, setting_value, setting_type, description, is_public) VALUES
('app_name', 'BMU AI Academic Advisor', 'string', 'Application name', TRUE),
('university_name', 'Bayelsa Medical University', 'string', 'Full university name', TRUE),
('university_motto', 'Service to God and Humanity', 'string', 'University motto', TRUE),
('max_message_length', '5000', 'number', 'Maximum message length in characters', FALSE),
('ai_system_prompt', 'You are Dr. Tari, the BMU AI Academic Advisor for Bayelsa Medical University (BMU). You help students, applicants, staff, and administrators understand academic policies, programme requirements, courses, fees, student handbook rules, and university procedures. Always be professional, accurate, and helpful. If you are unsure about a high-risk academic fact, say so and recommend consulting the appropriate university office.', 'string', 'AI system prompt', FALSE),
('enable_voice_responses', 'true', 'boolean', 'Enable voice/audio responses', FALSE),
('voice_accent', 'en-NG', 'string', 'Voice accent for TTS', FALSE),
('enable_whatsapp', 'false', 'boolean', 'Enable WhatsApp integration (deprecated: web-only)', FALSE),
('maintenance_mode', 'false', 'boolean', 'Enable maintenance mode', FALSE)
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

-- Create default superadmin account (password: Admin@123 - CHANGE IN PRODUCTION!)
INSERT INTO users (email, password, first_name, last_name, role, is_verified, is_active) VALUES
('bmuapps@bmu.edu.ng', '$2b$10$rQZ8K0K8K0K8K0K8K0K8K.placeholder_hash_change_this', 'System', 'Administrator', 'superadmin', TRUE, TRUE)
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

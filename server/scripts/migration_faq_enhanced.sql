-- Migration: Enhanced FAQ System
-- Adds support for phased Q&A generation and improved FAQ management

-- Add qa_type column to cached_qa for categorizing question types
ALTER TABLE cached_qa 
ADD COLUMN IF NOT EXISTS qa_type VARCHAR(50) DEFAULT 'general' 
AFTER answer_sources;

-- Add phase_info column to qa_generation_jobs for tracking phased generation
ALTER TABLE qa_generation_jobs 
ADD COLUMN IF NOT EXISTS phase_info JSON DEFAULT NULL 
AFTER error_message;

-- Add config column to qa_generation_jobs for storing generation options
ALTER TABLE qa_generation_jobs 
ADD COLUMN IF NOT EXISTS config JSON DEFAULT NULL 
AFTER phase_info;

-- Add index on qa_type for faster filtering
CREATE INDEX IF NOT EXISTS idx_cached_qa_type ON cached_qa(qa_type);

-- Add index on document_id + qa_type for document-specific type queries
CREATE INDEX IF NOT EXISTS idx_cached_qa_doc_type ON cached_qa(document_id, qa_type);

-- Update system_settings with new FAQ configuration options
INSERT INTO system_settings (setting_key, setting_value, setting_type, description, updated_at)
VALUES 
    ('faq_auto_generate', 'true', 'boolean', 'Automatically generate FAQ when documents are processed', NOW()),
    ('faq_phased_generation', 'true', 'boolean', 'Use phased generation for comprehensive FAQ coverage', NOW()),
    ('faq_chunk_size', '8000', 'number', 'Content chunk size for phased FAQ generation', NOW()),
    ('faq_max_questions_per_doc', '110', 'number', 'Maximum FAQ questions per document', NOW())
ON DUPLICATE KEY UPDATE 
    description = VALUES(description),
    updated_at = NOW();

-- View for FAQ generation status by document
CREATE OR REPLACE VIEW v_document_faq_status AS
SELECT 
    d.id AS document_id,
    d.title,
    d.category,
    d.embedding_status,
    COUNT(cq.id) AS faq_count,
    COUNT(CASE WHEN cq.qa_type = 'definitional' THEN 1 END) AS definitional_count,
    COUNT(CASE WHEN cq.qa_type = 'procedural' THEN 1 END) AS procedural_count,
    COUNT(CASE WHEN cq.qa_type = 'quantitative' THEN 1 END) AS quantitative_count,
    COUNT(CASE WHEN cq.qa_type = 'role_specific' THEN 1 END) AS role_specific_count,
    COUNT(CASE WHEN cq.qa_type = 'scenario' THEN 1 END) AS scenario_count,
    COUNT(CASE WHEN cq.qa_type = 'compliance' THEN 1 END) AS compliance_count,
    SUM(cq.usage_count) AS total_usage,
    MAX(cq.created_at) AS last_faq_generated,
    CASE 
        WHEN COUNT(cq.id) >= 80 THEN 'comprehensive'
        WHEN COUNT(cq.id) >= 40 THEN 'good'
        WHEN COUNT(cq.id) >= 20 THEN 'moderate'
        WHEN COUNT(cq.id) > 0 THEN 'minimal'
        ELSE 'none'
    END AS coverage_level
FROM documents d
LEFT JOIN cached_qa cq ON cq.document_id = d.id AND cq.is_active = TRUE
GROUP BY d.id, d.title, d.category, d.embedding_status;

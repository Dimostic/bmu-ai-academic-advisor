CREATE TABLE IF NOT EXISTS ccmas_programme_sections (
    id INT AUTO_INCREMENT PRIMARY KEY,
    document_id INT NOT NULL,
    document_title VARCHAR(255) NOT NULL,
    discipline VARCHAR(160) NULL,
    programme_code VARCHAR(40) NOT NULL,
    programme_name VARCHAR(180) NOT NULL,
    degree VARCHAR(80) NULL,
    section_key VARCHAR(80) NOT NULL,
    section_title VARCHAR(180) NOT NULL,
    content LONGTEXT NOT NULL,
    content_hash CHAR(64) NOT NULL,
    source_path VARCHAR(500) NULL,
    authority_type VARCHAR(80) DEFAULT 'regulator',
    scope_label VARCHAR(180) DEFAULT 'NUC CCMAS national minimum',
    status VARCHAR(40) DEFAULT 'active',
    chunk_start INT NULL,
    chunk_end INT NULL,
    extraction_version VARCHAR(80) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_ccmas_programme_section (document_id, programme_code, section_key, extraction_version),
    INDEX idx_ccmas_programme (programme_name, programme_code),
    INDEX idx_ccmas_section (section_key),
    INDEX idx_ccmas_status (status),
    CONSTRAINT fk_ccmas_programme_sections_document
        FOREIGN KEY (document_id) REFERENCES documents(id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

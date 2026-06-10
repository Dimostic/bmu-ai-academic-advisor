-- ============================================================================
-- BMU AI Academic Advisor — FAQ / Cached Q&A tables
--
-- This is the advisor-scoped re-application of the legacy migration_faq_cache.sql
-- which used `USE bmu_ai_agent;` and therefore silently failed against the
-- bmu_academic_advisor database. We keep the same table shape so the inherited
-- faqService / FAQCategory / CachedQA models and faqRoutes.js endpoints all
-- work unchanged.
--
-- Idempotent: re-running is safe (IF NOT EXISTS + ON DUPLICATE KEY UPDATE).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- faq_categories — top-level taxonomy used by the FAQ browse UI.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faq_categories (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    description   TEXT,
    icon          VARCHAR(50) DEFAULT 'fas fa-folder',
    display_order INT DEFAULT 0,
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_category_name (name),
    INDEX idx_active_order (is_active, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- cached_qa — pre-generated Q&A pairs from document chunks.
--   * `embedding` is a JSON-encoded float array (768-dim for nomic-embed-text).
--   * `question_variations` lets faqService.findSimilarQuestion match more
--     phrasings without re-embedding the same question.
--   * `usage_count` + `last_used_at` drive the "popular FAQs" endpoint.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cached_qa (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    document_id         INT,
    category_id         INT,
    question            TEXT NOT NULL,
    question_variations JSON,
    answer              TEXT NOT NULL,
    answer_sources      JSON,
    embedding           MEDIUMTEXT,
    confidence_score    DECIMAL(3,2) DEFAULT 1.00,
    usage_count         INT DEFAULT 0,
    last_used_at        DATETIME,
    is_verified         BOOLEAN DEFAULT FALSE,
    verified_by         INT,
    verified_at         DATETIME,
    is_active           BOOLEAN DEFAULT TRUE,
    created_by          INT,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_cached_qa_document   FOREIGN KEY (document_id) REFERENCES documents(id)        ON DELETE SET NULL,
    CONSTRAINT fk_cached_qa_category   FOREIGN KEY (category_id) REFERENCES faq_categories(id)   ON DELETE SET NULL,
    CONSTRAINT fk_cached_qa_verified   FOREIGN KEY (verified_by) REFERENCES users(id)            ON DELETE SET NULL,
    CONSTRAINT fk_cached_qa_created_by FOREIGN KEY (created_by)  REFERENCES users(id)            ON DELETE SET NULL,
    INDEX idx_document_id (document_id),
    INDEX idx_category_id (category_id),
    INDEX idx_active (is_active),
    INDEX idx_usage (usage_count DESC),
    FULLTEXT INDEX ft_question (question)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- qa_cache_hits — analytics log used by /api/faq/item/:id/feedback and the
-- admin metrics endpoints in adminRoutes.
-- NOTE: the legacy schema FK-references chat_sessions(id). The advisor uses
-- advisor_conversations instead, so we drop the FK and just keep an index.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qa_cache_hits (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    cached_qa_id      INT NOT NULL,
    user_id           INT,
    session_id        INT,
    user_query        TEXT NOT NULL,
    similarity_score  DECIMAL(4,3),
    response_time_ms  INT,
    was_helpful       BOOLEAN,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_cache_hit_qa   FOREIGN KEY (cached_qa_id) REFERENCES cached_qa(id) ON DELETE CASCADE,
    CONSTRAINT fk_cache_hit_user FOREIGN KEY (user_id)      REFERENCES users(id)     ON DELETE SET NULL,
    INDEX idx_cached_qa_id (cached_qa_id),
    INDEX idx_session_id   (session_id),
    INDEX idx_created_at   (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- qa_generation_jobs — tracks generateAllFAQs background runs so the admin
-- portal can show progress.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qa_generation_jobs (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    document_id          INT NOT NULL,
    status               ENUM('queued', 'processing', 'completed', 'failed') DEFAULT 'queued',
    questions_generated  INT DEFAULT 0,
    progress             INT DEFAULT 0,
    error_message        TEXT,
    started_at           DATETIME,
    completed_at         DATETIME,
    initiated_by         INT,
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_qa_job_document   FOREIGN KEY (document_id)   REFERENCES documents(id) ON DELETE CASCADE,
    CONSTRAINT fk_qa_job_initiator  FOREIGN KEY (initiated_by)  REFERENCES users(id)     ON DELETE SET NULL,
    INDEX idx_document_id (document_id),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Seed: the 9 advisor topics, mirroring advisor_topics from migration_advisor.sql.
-- Idempotent via ON DUPLICATE KEY UPDATE (uniq_category_name).
-- Display order is intentionally the same as advisor_topics so the FAQ browse
-- UI and the topic carousel show the same order to the student.
-- ---------------------------------------------------------------------------
INSERT INTO faq_categories (name, description, icon, display_order) VALUES
    ('Programmes, courses & registration', 'Programme structure, prerequisites, and course registration help.',  'fas fa-graduation-cap', 10),
    ('Academic calendar & exams',          'Important dates, semester timeline, exam timetable.',                 'fas fa-calendar',       20),
    ('Grading, GPA & transcripts',         'GPA/CGPA computation, withdrawal and probation rules, transcripts.',  'fas fa-percentage',     30),
    ('Fees, payments & scholarships',      'Tuition, payment schedules, scholarships and bursary support.',       'fas fa-naira-sign',     40),
    ('Hostel, accommodation & transport',  'On-campus living, hostel allocation, and getting around.',            'fas fa-bed',            50),
    ('Health, counselling & student welfare', 'Clinic, counselling, mental-health, and student support services.','fas fa-heart-pulse',    60),
    ('Library & study skills',             'Library access, e-resources, and effective study techniques.',        'fas fa-book',           70),
    ('Code of conduct & complaints',       'Student code of conduct, disciplinary procedures, and grievances.',   'fas fa-gavel',          80),
    ('Career guidance, internship & clinical postings', 'Career planning, internships, postings, and life after BMU.', 'fas fa-briefcase', 90)
ON DUPLICATE KEY UPDATE
    description   = VALUES(description),
    icon          = VALUES(icon),
    display_order = VALUES(display_order),
    is_active     = TRUE;

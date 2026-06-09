-- ============================================================================
-- BMU AI Academic Advisor - schema additions
-- Adds student-focused tables on top of the inherited users/documents schema.
-- Idempotent: safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Human academic advisors (real people behind escalations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS human_advisors (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    full_name       VARCHAR(150) NOT NULL,
    email           VARCHAR(190) NOT NULL UNIQUE,
    phone           VARCHAR(40)  NULL,
    department      VARCHAR(150) NULL,
    role_title      VARCHAR(120) NULL,
    is_available    BOOLEAN NOT NULL DEFAULT TRUE,
    notes           TEXT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_human_advisors_avail (is_available)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Students (linked to a `users` row when self-registered).
-- Matric number format: e.g. UG/24/1056 (programme/year/serial).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    user_id             INT NULL,
    matric_no           VARCHAR(40) NOT NULL UNIQUE,
    full_name           VARCHAR(180) NOT NULL,
    email               VARCHAR(190) NULL,
    phone               VARCHAR(40)  NULL,
    programme_code      VARCHAR(30)  NULL,   -- e.g. MBBS, BNSC, BMLS
    programme_name      VARCHAR(180) NULL,
    faculty             VARCHAR(150) NULL,
    department          VARCHAR(150) NULL,
    level               SMALLINT     NULL,   -- 100, 200, 300, 400, 500, 600
    year_of_entry       SMALLINT     NULL,
    current_session     VARCHAR(20)  NULL,   -- e.g. 2024/2025
    primary_advisor_id  INT NULL,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_students_user    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_students_advisor FOREIGN KEY (primary_advisor_id) REFERENCES human_advisors(id) ON DELETE SET NULL,
    INDEX idx_students_programme (programme_code),
    INDEX idx_students_level (level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Knowledge categories (the 9 launch topic areas, hierarchical).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advisor_topics (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    parent_id     INT NULL,
    slug          VARCHAR(80) NOT NULL UNIQUE,
    title         VARCHAR(180) NOT NULL,
    description   TEXT NULL,
    icon          VARCHAR(80) NULL,        -- font-awesome class or asset name
    display_order INT NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_topics_parent FOREIGN KEY (parent_id) REFERENCES advisor_topics(id) ON DELETE CASCADE,
    INDEX idx_topics_order (display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Curated topic content: short authoritative answers for each topic.
-- Used in addition to RAG over uploaded documents (`documents` table).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topic_content (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    topic_id       INT NOT NULL,
    title          VARCHAR(220) NOT NULL,
    body_markdown  MEDIUMTEXT NOT NULL,
    source_doc_id  INT NULL,                -- optional FK to documents.id
    tags           VARCHAR(255) NULL,
    is_published   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_topic_content_topic FOREIGN KEY (topic_id) REFERENCES advisor_topics(id) ON DELETE CASCADE,
    FULLTEXT INDEX ft_topic_content (title, body_markdown)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Conversations + messages (separate from the inherited chat_* tables so the
-- advisor UI can evolve independently and store speech/visemes metadata).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advisor_conversations (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    student_id      INT NULL,                -- NULL for guest sessions
    session_token   CHAR(36) NOT NULL UNIQUE,
    title           VARCHAR(220) NULL,
    language        VARCHAR(20) NOT NULL DEFAULT 'en-NG',
    voice_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
    last_topic_id   INT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_advisor_conv_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL,
    CONSTRAINT fk_advisor_conv_topic   FOREIGN KEY (last_topic_id) REFERENCES advisor_topics(id) ON DELETE SET NULL,
    INDEX idx_advisor_conv_student (student_id),
    INDEX idx_advisor_conv_last_active (last_active_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS advisor_messages (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id   INT NOT NULL,
    role              ENUM('student','advisor','system') NOT NULL,
    input_mode        ENUM('text','voice') NOT NULL DEFAULT 'text',
    text              MEDIUMTEXT NOT NULL,
    speech_text       TEXT NULL,             -- short spoken version of an advisor reply
    display_markdown  MEDIUMTEXT NULL,       -- richer written version typed in the UI
    audio_url         VARCHAR(500) NULL,
    visemes_json      MEDIUMTEXT NULL,       -- Azure viseme stream for lip-sync
    citations_json    MEDIUMTEXT NULL,
    suggested_actions_json MEDIUMTEXT NULL,
    follow_ups_json   MEDIUMTEXT NULL,
    topic_id          INT NULL,
    latency_ms        INT NULL,
    tokens_in         INT NULL,
    tokens_out        INT NULL,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_advisor_msg_conv  FOREIGN KEY (conversation_id) REFERENCES advisor_conversations(id) ON DELETE CASCADE,
    CONSTRAINT fk_advisor_msg_topic FOREIGN KEY (topic_id) REFERENCES advisor_topics(id) ON DELETE SET NULL,
    INDEX idx_advisor_msg_conv (conversation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Personalised study plans (student-built, advisor-guided).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS study_plans (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    student_id   INT NOT NULL,
    title        VARCHAR(220) NOT NULL,
    target_term  VARCHAR(40) NULL,           -- e.g. "First Semester 2025/2026"
    status       ENUM('draft','active','archived','completed') NOT NULL DEFAULT 'draft',
    summary      TEXT NULL,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_study_plans_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    INDEX idx_study_plans_student (student_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS study_plan_items (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    plan_id      INT NOT NULL,
    position     INT NOT NULL DEFAULT 0,
    title        VARCHAR(220) NOT NULL,
    description  TEXT NULL,
    course_code  VARCHAR(40) NULL,
    action_type  ENUM('study','register','submit','attend','prepare','meet','other') NOT NULL DEFAULT 'study',
    due_date     DATE NULL,
    status       ENUM('todo','in_progress','done','skipped') NOT NULL DEFAULT 'todo',
    notes        TEXT NULL,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_study_plan_items_plan FOREIGN KEY (plan_id) REFERENCES study_plans(id) ON DELETE CASCADE,
    INDEX idx_study_plan_items_plan (plan_id, position),
    INDEX idx_study_plan_items_status (status, due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Escalations: AI couldn't answer / student requested a human.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS escalations (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    student_id        INT NULL,
    conversation_id   INT NULL,
    topic_id          INT NULL,
    subject           VARCHAR(220) NOT NULL,
    message           MEDIUMTEXT NOT NULL,
    contact_email     VARCHAR(190) NULL,
    contact_phone     VARCHAR(40)  NULL,
    assigned_advisor_id INT NULL,
    assigned_email    VARCHAR(190) NULL,
    status            ENUM('open','in_progress','resolved','closed') NOT NULL DEFAULT 'open',
    priority          ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
    email_sent_at     TIMESTAMP NULL,
    response_message  MEDIUMTEXT NULL,
    resolved_at       TIMESTAMP NULL,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_escalations_student   FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL,
    CONSTRAINT fk_escalations_conv      FOREIGN KEY (conversation_id) REFERENCES advisor_conversations(id) ON DELETE SET NULL,
    CONSTRAINT fk_escalations_topic     FOREIGN KEY (topic_id) REFERENCES advisor_topics(id) ON DELETE SET NULL,
    CONSTRAINT fk_escalations_assignee  FOREIGN KEY (assigned_advisor_id) REFERENCES human_advisors(id) ON DELETE SET NULL,
    INDEX idx_escalations_status (status, priority, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Seed: the 9 launch topic areas. ON DUPLICATE KEY UPDATE keeps it idempotent.
-- ---------------------------------------------------------------------------
INSERT INTO advisor_topics (slug, title, description, icon, display_order) VALUES
    ('programmes',     'Programmes, courses & registration',          'Programme structure, prerequisites, and course registration help.',     'fa-graduation-cap', 10),
    ('calendar',       'Academic calendar & exams',                   'Important dates, semester timeline, exam timetable.',                    'fa-calendar',       20),
    ('grading',        'Grading, GPA & transcripts',                  'GPA/CGPA computation, withdrawal and probation rules, transcripts.',     'fa-percentage',     30),
    ('fees',           'Fees, payments & scholarships',               'Tuition, payment schedules, scholarships and bursary support.',          'fa-naira-sign',     40),
    ('hostel',         'Hostel, accommodation & transport',           'Hostel allocation, off-campus housing, transport options.',              'fa-bed',            50),
    ('welfare',        'Health, counselling & student welfare',       'Clinic services, counselling, welfare and emergencies.',                 'fa-heart-pulse',    60),
    ('library',        'Library, e-resources & study skills',         'Library access, e-resources, reading and study techniques.',             'fa-book-open',      70),
    ('conduct',        'Code of conduct, complaints & escalations',   'Student conduct, disciplinary process, complaints and appeals.',         'fa-scale-balanced', 80),
    ('career',         'Career, internship & clinical postings',      'Career guidance, internships, clinical postings and placements.',        'fa-briefcase',      90)
ON DUPLICATE KEY UPDATE
    title         = VALUES(title),
    description   = VALUES(description),
    icon          = VALUES(icon),
    display_order = VALUES(display_order);

-- ---------------------------------------------------------------------------
-- Seed: a placeholder human advisor for escalation emails.
-- Update the email after first install or via the admin UI.
-- ---------------------------------------------------------------------------
INSERT INTO human_advisors (full_name, email, department, role_title, is_available)
SELECT 'BMU Academic Advisor Desk', 'advisor@bmu.edu.ng', 'Academic Affairs', 'Coordinator', TRUE
WHERE NOT EXISTS (SELECT 1 FROM human_advisors WHERE email = 'advisor@bmu.edu.ng');

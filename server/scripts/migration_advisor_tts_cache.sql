-- BMU AI Academic Advisor - TTS audio cache
-- Stores TTSMaker (or other provider) audio URLs by text+voice+speed hash so
-- repeat questions don't burn TTSMaker character quota. Idempotent.

CREATE TABLE IF NOT EXISTS tts_audio_cache (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    text_hash     CHAR(64) NOT NULL,                -- sha256(normalised_text|voice_id|audio_speed)
    voice_id      INT NOT NULL,
    audio_speed   DECIMAL(4,2) NOT NULL DEFAULT 1.00,
    text_preview  VARCHAR(255) NOT NULL,
    audio_url     VARCHAR(1024) NOT NULL,
    backup_url    VARCHAR(1024) NULL,
    provider      VARCHAR(40) NOT NULL DEFAULT 'ttsmaker',
    expires_at    TIMESTAMP NOT NULL,
    hit_count     INT NOT NULL DEFAULT 0,
    last_hit_at   TIMESTAMP NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_tts_cache (text_hash, voice_id, audio_speed),
    INDEX idx_tts_cache_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

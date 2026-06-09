-- Add audio_url columns for VC chat TTS playback
ALTER TABLE vc_document_chat_messages
    ADD COLUMN IF NOT EXISTS audio_url VARCHAR(255) NULL AFTER content;

ALTER TABLE vc_report_chat_messages
    ADD COLUMN IF NOT EXISTS audio_url VARCHAR(255) NULL AFTER content;

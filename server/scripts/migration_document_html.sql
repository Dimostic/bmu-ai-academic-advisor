-- Migration: Add content_html column for preserving document formatting
-- Created: 2026-01-05
-- Purpose: Store HTML version of documents for proper display in viewer

-- Add content_html column to documents table
ALTER TABLE documents 
ADD COLUMN IF NOT EXISTS content_html LONGTEXT AFTER content_text;

-- Done!
SELECT 'Migration completed: content_html column added' as status;

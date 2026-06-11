-- ============================================================================
-- BMU AI Academic Advisor — add 'student' role
--
-- Self-registration was previously creating accounts as role='staff' which
-- was misleading (the audience is mostly students). This migration:
--   1. Widens the users.role ENUM to include 'student'.
--   2. Re-tags any existing self-registered staff that look like students
--      (matric_no present and not an admin) so the dashboard reflects
--      reality.
--
-- Idempotent: re-running is safe. We always set the ENUM to the full target
-- set (existing rows are preserved by MySQL), and the UPDATE has WHERE guards.
-- ============================================================================

ALTER TABLE users MODIFY COLUMN role
    ENUM('student', 'staff', 'admin', 'superadmin') NOT NULL DEFAULT 'student';

-- Anyone who self-registered with a matric number is a student. Anyone
-- without a matric who's still in the default 'staff' bucket gets left
-- alone (the admin can re-tag them by hand if needed).
UPDATE users
SET role = 'student'
WHERE role = 'staff'
  AND matric_no IS NOT NULL
  AND matric_no <> '';

SELECT 'student role migration complete' AS status;

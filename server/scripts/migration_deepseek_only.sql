-- Migration: Simplify to DeepSeek only & update user limits
-- Date: 2026-01-07
-- Description: Update all regular users to 100 prompts/month limit,
--              clean up any model-specific data

-- Update regular users to 100 prompts/month (was 30)
UPDATE users 
SET monthly_prompt_limit = 100 
WHERE role = 'staff' AND (monthly_prompt_limit IS NULL OR monthly_prompt_limit < 100);

-- Ensure admin and superadmin have unlimited (-1)
UPDATE users 
SET monthly_prompt_limit = -1 
WHERE role IN ('admin', 'superadmin');

-- Reset monthly prompt counts for new month (optional - run if starting fresh)
-- UPDATE users SET monthly_prompt_count = 0;

-- Clean up usage_logs model references to standardize on 'deepseek-chat'
UPDATE usage_logs 
SET model_id = 'deepseek-chat' 
WHERE model_id IS NULL OR model_id = '' OR model_id = 'unknown';

-- Show results
SELECT 
    role,
    COUNT(*) as user_count,
    AVG(monthly_prompt_limit) as avg_limit
FROM users 
GROUP BY role;

-- Show current month's usage summary
SELECT 
    u.role,
    COUNT(DISTINCT ul.user_id) as users_with_usage,
    SUM(ul.request_count) as total_requests,
    AVG(ul.request_count) as avg_requests_per_user
FROM usage_logs ul
JOIN users u ON ul.user_id = u.id
WHERE ul.month_year = DATE_FORMAT(NOW(), '%Y-%m')
GROUP BY u.role;

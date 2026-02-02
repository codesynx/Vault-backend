-- Script to clean up duplicate messages caused by the double-archiving bug
-- This script identifies and removes messages with TDLib temp IDs (very large numbers)
-- while keeping the messages with real Telegram IDs (smaller sequential numbers)

-- First, let's see what duplicates we have (preview without deleting)
-- Duplicates are outgoing messages with the same chat, sender, content, and similar timestamp
-- but different telegram_message_id values

WITH duplicate_candidates AS (
    SELECT
        m1.id AS temp_id,
        m1.telegram_message_id AS temp_telegram_id,
        m2.id AS real_id,
        m2.telegram_message_id AS real_telegram_id,
        m1.chat_id,
        m1.content,
        m1.telegram_created_at
    FROM messages m1
    INNER JOIN messages m2 ON
        m1.chat_id = m2.chat_id
        AND m1.sender_id = m2.sender_id
        AND m1.content = m2.content
        AND m1.is_outgoing = true
        AND m2.is_outgoing = true
        AND m1.telegram_message_id != m2.telegram_message_id
        -- Temp IDs are typically > 4000000000000 (TDLib uses high numbers)
        -- Real IDs are typically < 1000000000
        AND m1.telegram_message_id > 4000000000000
        AND m2.telegram_message_id < 4000000000000
        -- Messages should be within 60 seconds of each other
        AND ABS(EXTRACT(EPOCH FROM (m1.telegram_created_at - m2.telegram_created_at))) < 60
)
SELECT * FROM duplicate_candidates;

-- Count of duplicates
SELECT COUNT(*) AS duplicate_count FROM (
    SELECT m1.id
    FROM messages m1
    INNER JOIN messages m2 ON
        m1.chat_id = m2.chat_id
        AND m1.sender_id = m2.sender_id
        AND m1.content = m2.content
        AND m1.is_outgoing = true
        AND m2.is_outgoing = true
        AND m1.telegram_message_id != m2.telegram_message_id
        AND m1.telegram_message_id > 4000000000000
        AND m2.telegram_message_id < 4000000000000
        AND ABS(EXTRACT(EPOCH FROM (m1.telegram_created_at - m2.telegram_created_at))) < 60
) AS dupes;

-- UNCOMMENT THE BELOW TO ACTUALLY DELETE THE DUPLICATES
-- Make sure to backup your database first!

-- Delete messages with temp IDs (the duplicates)
-- DELETE FROM messages
-- WHERE id IN (
--     SELECT m1.id
--     FROM messages m1
--     INNER JOIN messages m2 ON
--         m1.chat_id = m2.chat_id
--         AND m1.sender_id = m2.sender_id
--         AND m1.content = m2.content
--         AND m1.is_outgoing = true
--         AND m2.is_outgoing = true
--         AND m1.telegram_message_id != m2.telegram_message_id
--         AND m1.telegram_message_id > 4000000000000
--         AND m2.telegram_message_id < 4000000000000
--         AND ABS(EXTRACT(EPOCH FROM (m1.telegram_created_at - m2.telegram_created_at))) < 60
-- );

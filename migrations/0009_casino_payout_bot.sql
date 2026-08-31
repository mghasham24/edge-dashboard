ALTER TABLE casino_withdrawals ADD COLUMN target_card_id INTEGER;
ALTER TABLE casino_withdrawals ADD COLUMN skipped_cards TEXT;
ALTER TABLE casino_withdrawals ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE casino_withdrawals ADD COLUMN last_attempt_at INTEGER;

-- Track card IDs that returned "listed in marketplace" so payout.js can skip them on retry
ALTER TABLE payout_queue ADD COLUMN skipped_cards TEXT;

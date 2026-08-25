-- Track multi-card payouts (wins over 10K need two separate card offers)
ALTER TABLE payout_queue ADD COLUMN card1_id INTEGER;
ALTER TABLE payout_queue ADD COLUMN card1_sent_at INTEGER;

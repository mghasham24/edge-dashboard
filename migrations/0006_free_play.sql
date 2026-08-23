-- Migration 0006: Free play referral system (completely separate from Stripe referrals)
-- free_play_credits:        how many free 100-Rax parlays the referrer has earned
-- parlay_referred_by_id:    internal user_id of who referred this user (set at verify time, one-time)
-- parlay_referral_rewarded: 1 once referred user's cumulative stake crosses 2k — prevents double-credit
ALTER TABLE users ADD COLUMN free_play_credits       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN parlay_referred_by_id   INTEGER;
ALTER TABLE users ADD COLUMN parlay_referral_rewarded INTEGER NOT NULL DEFAULT 0;

-- is_free_play: 1 = placed as a free play (no deposit required, payout capped at 3000)
ALTER TABLE parlays ADD COLUMN is_free_play INTEGER NOT NULL DEFAULT 0;

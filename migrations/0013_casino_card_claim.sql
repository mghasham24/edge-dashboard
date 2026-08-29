-- Atomic casino card claim — mirrors assigned_to_parlay_id pattern in parlays.
-- claimed_for_casino_at: unix timestamp when the card was claimed for a pending casino deposit.
-- NULL means available. Expires after DEPOSIT_TTL (3 min) if no deposit confirmed.
ALTER TABLE deposit_cards ADD COLUMN claimed_for_casino_at INTEGER DEFAULT NULL;

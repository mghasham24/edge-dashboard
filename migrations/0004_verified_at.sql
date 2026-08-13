-- Add verified_at to deposit_cards so place.js can reject cards
-- that haven't been confirmed as edgebot-owned in the last reconcile cycle.
ALTER TABLE deposit_cards ADD COLUMN verified_at INTEGER;

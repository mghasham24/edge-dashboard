-- Tag deposit cards by sport/season so parlays and casino use separate pools.
-- Existing rows are MLB 2025 (the only source synced before this migration).
ALTER TABLE deposit_cards ADD COLUMN sport TEXT DEFAULT 'mlb';
ALTER TABLE deposit_cards ADD COLUMN season TEXT DEFAULT '2025';

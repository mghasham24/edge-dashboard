ALTER TABLE parlays ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_parlays_share_token ON parlays(share_token) WHERE share_token IS NOT NULL;

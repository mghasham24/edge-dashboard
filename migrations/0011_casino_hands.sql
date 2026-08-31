CREATE TABLE IF NOT EXISTS casino_hands (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  game_id      INTEGER NOT NULL,
  bet_total    INTEGER NOT NULL,
  payout_total INTEGER NOT NULL,
  profit       INTEGER NOT NULL,
  hands_json   TEXT    NOT NULL,
  dealer_cards TEXT    NOT NULL,
  dealer_total INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_casino_hands_user    ON casino_hands(user_id);
CREATE INDEX IF NOT EXISTS idx_casino_hands_created ON casino_hands(created_at);

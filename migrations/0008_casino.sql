-- migrations/0008_casino.sql
-- Casino system: blackjack games, deposits, withdrawals, casino balance on users

ALTER TABLE users ADD COLUMN casino_balance INTEGER NOT NULL DEFAULT 0;

CREATE TABLE blackjack_games (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  deck                TEXT NOT NULL,
  hands               TEXT NOT NULL,
  active_hand_idx     INTEGER NOT NULL DEFAULT 0,
  dealer_hand         TEXT NOT NULL,
  dealer_hole_visible INTEGER NOT NULL DEFAULT 0,
  insurance_offered   INTEGER NOT NULL DEFAULT 0,
  insurance_resolved  INTEGER NOT NULL DEFAULT 0,
  insurance_bet       INTEGER,
  status              TEXT NOT NULL DEFAULT 'active',
  result              TEXT,
  moves               TEXT NOT NULL DEFAULT '[]',
  version             INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_blackjack_games_user_status ON blackjack_games(user_id, status);

CREATE TABLE casino_deposits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  rax_requested INTEGER NOT NULL,
  rax_credited  INTEGER,
  card_id       INTEGER,
  rs_offer_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_casino_deposits_user ON casino_deposits(user_id, status);

CREATE TABLE casino_withdrawals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  amount      INTEGER NOT NULL,
  rs_username TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  notes       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_casino_withdrawals_status ON casino_withdrawals(status, created_at);

-- Migration 0008: Leaderboard reward system
-- 1. Make payout_queue.parlay_id nullable so rewards can be queued without a parlay record.
--    SQLite doesn't support ALTER COLUMN — recreate the table.
-- 2. Add leaderboard_reward_log for idempotency (one row per week × rank).

PRAGMA foreign_keys=OFF;

CREATE TABLE payout_queue_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  parlay_id       INTEGER REFERENCES parlays(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL,
  rs_username     TEXT    NOT NULL,
  payout_rax      INTEGER NOT NULL,
  offer_amount    INTEGER NOT NULL,
  target_card_id  INTEGER,
  rs_offer_id     INTEGER,
  status          TEXT    NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  notes           TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at         INTEGER,
  skipped_cards   TEXT
);

INSERT INTO payout_queue_new
  SELECT id, parlay_id, user_id, rs_username, payout_rax, offer_amount,
         target_card_id, rs_offer_id, status, attempts, last_attempt_at,
         notes, created_at, sent_at, skipped_cards
  FROM payout_queue;

DROP TABLE payout_queue;
ALTER TABLE payout_queue_new RENAME TO payout_queue;

CREATE INDEX IF NOT EXISTS idx_payout_status ON payout_queue(status);
CREATE INDEX IF NOT EXISTS idx_payout_parlay ON payout_queue(parlay_id);

PRAGMA foreign_keys=ON;

-- Idempotency log — one row per (week_key, rank) prevents double-rewarding
CREATE TABLE IF NOT EXISTS leaderboard_reward_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  week_key    TEXT    NOT NULL,
  rank        INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  rs_username TEXT    NOT NULL,
  amount_rax  INTEGER NOT NULL,
  rewarded_at INTEGER NOT NULL,
  UNIQUE(week_key, rank)
);

-- migrations/0002_parlays.sql
-- Parlays system: parlays, legs, payout queue, deposit card pool.
-- Apply with: npx wrangler d1 execute edge-db --remote --file=migrations/0002_parlays.sql

-- ─── parlays ──────────────────────────────────────────────────────────────────
-- One row per user parlay slip.
--
-- status flow:
--   pending_deposit → active → in_progress → pending_settlement → won/lost/pushed/void/expired
--
-- payout math (stored at placement, updated if legs are voided):
--   true_prob   = product of implied_prob across all non-void legs
--   payout_rax  = min(floor(stake_rax × 0.72 / true_prob), 10000)  ← what user receives
--   offer_amount (in payout_queue) = ceil(payout_rax / 0.9)        ← what edgebot offers
--
-- received_rax: actual Rax edgebot netted from deposit offer (offer_amount × 0.9).
--   Set when deposit is confirmed. Allows detecting overpay/underpay discrepancies.
CREATE TABLE IF NOT EXISTS parlays (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              TEXT    NOT NULL DEFAULT 'pending_deposit',
  sport               TEXT    NOT NULL DEFAULT 'baseball_mlb',
  legs_count          INTEGER NOT NULL,
  stake_rax           INTEGER NOT NULL,
  true_prob           REAL    NOT NULL,
  payout_rax          INTEGER NOT NULL,
  deposit_card_id     INTEGER,
  rs_offer_id         INTEGER,
  received_rax        INTEGER,
  rs_username         TEXT    NOT NULL,
  payout_offer_id     INTEGER,
  admin_notes         TEXT,
  expires_at          INTEGER NOT NULL,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  deposited_at        INTEGER,
  settled_at          INTEGER
);

-- ─── parlay_legs ──────────────────────────────────────────────────────────────
-- One row per leg. Settled independently; parlay settles when all legs are done.
--
-- market_type values: 'home_runs' | 'hits' | 'pitcher_ks' | 'outs_ou'
-- direction: 'over' | 'under' | null (null = milestone "yes" bet, e.g. "1+ HR")
-- threshold: for milestones = the count (1, 2, 3); for O/U = the line (18.5)
-- label: display string shown to user, e.g. "1+", "Over 18.5"
--
-- settlement:
--   milestone → won if result_value >= threshold
--   O/U over  → won if result_value > threshold; push if result_value == threshold
--   O/U under → won if result_value < threshold; push if result_value == threshold
CREATE TABLE IF NOT EXISTS parlay_legs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  parlay_id       INTEGER NOT NULL REFERENCES parlays(id) ON DELETE CASCADE,
  sport           TEXT    NOT NULL DEFAULT 'baseball_mlb',
  event_id        TEXT    NOT NULL,
  event_name      TEXT    NOT NULL,
  game_date       TEXT    NOT NULL,
  subcat_id       INTEGER NOT NULL,
  market_type     TEXT    NOT NULL,
  market_id       TEXT    NOT NULL,
  selection_id    TEXT    NOT NULL,
  player_name     TEXT    NOT NULL,
  label           TEXT    NOT NULL,
  threshold       REAL,
  direction       TEXT,
  american_odds   INTEGER NOT NULL,
  implied_prob    REAL    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending',
  result_value    REAL,
  settled_at      INTEGER
);

-- ─── payout_queue ─────────────────────────────────────────────────────────────
-- Async queue for outgoing RS offer creation after a parlay wins.
-- status: pending | sent | accepted | failed | manual
--
-- offer_amount = ceil(payout_rax / 0.9) — what edgebot creates the offer for.
-- RS takes 10% so user nets payout_rax from an offer_amount offer.
-- target_card_id: a user-owned card that edgebot offers to buy.
-- If user has no cards, status stays 'pending'; admin resolves via notes + DM.
CREATE TABLE IF NOT EXISTS payout_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  parlay_id       INTEGER NOT NULL UNIQUE REFERENCES parlays(id),
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
  sent_at         INTEGER
);

-- ─── deposit_cards ────────────────────────────────────────────────────────────
-- Pool of edgebot RS cards used as deposit targets.
-- Each pending parlay gets one assigned card; user is shown that card's URL.
-- Deposit cron polls RS incoming offers, matches offer.cardId → this table.
-- Card is freed when parlay leaves pending_deposit (deposited, expired, or void).
--
-- Pre-populate with edgebot's card IDs before first user parlay can be placed:
--   INSERT OR IGNORE INTO deposit_cards (card_id) VALUES (123456789), ...;
CREATE TABLE IF NOT EXISTS deposit_cards (
  card_id               INTEGER PRIMARY KEY,
  assigned_to_parlay_id INTEGER,
  assigned_at           INTEGER,
  freed_at              INTEGER
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_parlays_user         ON parlays(user_id);
CREATE INDEX IF NOT EXISTS idx_parlays_status       ON parlays(status);
CREATE INDEX IF NOT EXISTS idx_parlays_deposit_card ON parlays(deposit_card_id);
CREATE INDEX IF NOT EXISTS idx_parlays_expires      ON parlays(expires_at);
CREATE INDEX IF NOT EXISTS idx_parlay_legs_parlay   ON parlay_legs(parlay_id);
CREATE INDEX IF NOT EXISTS idx_parlay_legs_date     ON parlay_legs(game_date, status);
CREATE INDEX IF NOT EXISTS idx_parlay_legs_event    ON parlay_legs(event_id);
CREATE INDEX IF NOT EXISTS idx_payout_status        ON payout_queue(status);
CREATE INDEX IF NOT EXISTS idx_payout_parlay        ON payout_queue(parlay_id);
CREATE INDEX IF NOT EXISTS idx_deposit_assigned     ON deposit_cards(assigned_to_parlay_id);

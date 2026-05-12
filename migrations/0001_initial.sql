-- migrations/0001_initial.sql
-- Full schema snapshot as of 2026-05-12.
-- To recreate a fresh D1 database:
--   npx wrangler d1 execute edge-db --remote --file=migrations/0001_initial.sql

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash     TEXT    NOT NULL,
  plan              TEXT    NOT NULL DEFAULT 'free',
  is_admin          INTEGER NOT NULL DEFAULT 0,
  banned            INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  stripe_sub_id     TEXT,
  referral_code     TEXT,
  referred_by       TEXT,
  pro_expires_at    INTEGER,
  had_free_trial    INTEGER NOT NULL DEFAULT 0,
  referral_credits  INTEGER DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT    NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS password_resets (
  user_id    INTEGER NOT NULL UNIQUE,
  token      TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS real_auth (
  user_id     INTEGER PRIMARY KEY,
  auth_token  TEXT,
  device_uuid TEXT,
  rs_username TEXT,
  rs_user_id  TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_settings (
  user_id          INTEGER PRIMARY KEY,
  telegram_chat_id TEXT,
  telegram_verified INTEGER DEFAULT 0,
  enabled          INTEGER DEFAULT 1,
  min_ev           REAL    DEFAULT 5.0,
  sports           TEXT    DEFAULT 'ALL',
  one_side         INTEGER DEFAULT 0,
  unit_size        REAL    DEFAULT 100,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_verify_tokens (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  chat_id    TEXT    NOT NULL,
  msg_id     INTEGER,
  bet_key    TEXT    NOT NULL,
  sport      TEXT,
  game       TEXT,
  market     TEXT,
  side       TEXT,
  pt         REAL,
  ev         REAL,
  units      REAL,
  dollar_amt INTEGER,
  taken      INTEGER DEFAULT 0,
  sent_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_sent_log (
  user_id  INTEGER NOT NULL,
  bet_key  TEXT    NOT NULL,
  last_ev  REAL    NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, bet_key)
);

CREATE TABLE IF NOT EXISTS bets_taken (
  user_id    INTEGER PRIMARY KEY,
  bet_ids    TEXT    NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bet_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  game       TEXT    NOT NULL,
  market     TEXT    NOT NULL,
  side       TEXT    NOT NULL,
  odds       INTEGER NOT NULL,
  line       REAL,
  stake      REAL    NOT NULL,
  sport      TEXT,
  result     TEXT    DEFAULT 'pending',
  real_pct   REAL,
  game_time  INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS odds_cache (
  cache_key  TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  user_id INTEGER NOT NULL,
  date    TEXT    NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key        TEXT    PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referrals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL,
  referred_id INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(referrer_id, referred_id)
);

CREATE TABLE IF NOT EXISTS trial_fingerprints (
  fingerprint TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id     TEXT    PRIMARY KEY,
  processed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rs_posted_positions (
  position_id TEXT    PRIMARY KEY,
  posted_at   INTEGER NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_bet_log_user   ON bet_log(user_id, created_at);

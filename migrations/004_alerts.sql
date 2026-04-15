-- Migration 004: Telegram alert system

-- User alert preferences (one row per user)
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id          INTEGER PRIMARY KEY,
  telegram_chat_id TEXT,
  telegram_verified INTEGER DEFAULT 0,
  enabled          INTEGER DEFAULT 1,
  min_ev           REAL    DEFAULT 5.0,
  sports           TEXT    DEFAULT 'ALL',
  updated_at       INTEGER NOT NULL
);

-- Temporary tokens for linking Telegram account to RaxEdge account
-- User clicks deep link → Telegram sends /start {token} → we match token to user_id
CREATE TABLE IF NOT EXISTS telegram_verify_tokens (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Deduplication log: tracks what was sent and at what EV
-- Re-alert fires only when current_ev > last_ev + 4.0 (meaningful EV jump = new unit tier)
CREATE TABLE IF NOT EXISTS alert_sent_log (
  user_id  INTEGER NOT NULL,
  bet_key  TEXT    NOT NULL,
  last_ev  REAL    NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, bet_key)
);

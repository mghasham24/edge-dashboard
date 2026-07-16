-- migrations/0002_onboarding_emails.sql
-- Onboarding email sequence tracking + magic-link tokens for pre-auth deep links.

CREATE TABLE IF NOT EXISTS onboarding_emails (
  user_id  INTEGER NOT NULL,
  step     INTEGER NOT NULL,  -- 1 = welcome, 2 = T+24h, 3 = T+72h, 4 = T+11d
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, step)
);

CREATE TABLE IF NOT EXISTS magic_tokens (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onboarding_step ON onboarding_emails(step, sent_at);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_exp ON magic_tokens(expires_at);

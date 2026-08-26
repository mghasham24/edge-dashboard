-- Add Discord fields to notification_settings
ALTER TABLE notification_settings ADD COLUMN discord_user_id TEXT;
ALTER TABLE notification_settings ADD COLUMN discord_dm_channel_id TEXT;
ALTER TABLE notification_settings ADD COLUMN discord_verified INTEGER NOT NULL DEFAULT 0;

-- Discord connect tokens (6-char code user DMs to the bot)
CREATE TABLE IF NOT EXISTS discord_verify_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

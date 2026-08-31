CREATE TABLE casino_mines_games (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  bet_rax        INTEGER NOT NULL,
  mines_count    INTEGER NOT NULL,
  mine_positions TEXT    NOT NULL, -- JSON array of tile indices (0-24), never sent to client mid-game
  revealed       TEXT    NOT NULL DEFAULT '[]', -- JSON array of revealed gem indices
  gems_revealed  INTEGER NOT NULL DEFAULT 0,
  multiplier     REAL    NOT NULL DEFAULT 1.0,
  status         TEXT    NOT NULL DEFAULT 'active', -- active | won | lost
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_casino_mines_user_status ON casino_mines_games(user_id, status);

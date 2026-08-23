-- Add rs_game_id to parlay_legs so the RS game URL can be built directly
-- without fuzzy name matching against rsGameIds at render time.
-- NULL for legs placed before this migration; those fall back to name-based lookup.
ALTER TABLE parlay_legs ADD COLUMN rs_game_id INTEGER;

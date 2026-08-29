-- Add team shortname column to parlay_legs for logo resolution in My Slips
ALTER TABLE parlay_legs ADD COLUMN team TEXT;

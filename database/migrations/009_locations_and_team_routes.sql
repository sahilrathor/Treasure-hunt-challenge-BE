-- Migration 009: Locations, clues, notes, and team round route assignments

-- 1. Add clue, note, show_note_to_player, and plain qr_token to checkpoints table
ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS clue text NOT NULL DEFAULT '';
ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS show_note_to_player boolean NOT NULL DEFAULT false;
ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS qr_token text;

-- 2. Populate clue from rounds for existing checkpoints if empty
UPDATE checkpoints c
SET clue = r.clue
FROM rounds r
WHERE r.checkpoint_id = c.id AND (c.clue IS NULL OR c.clue = '');

-- 3. Relax constraints on rounds.checkpoint_id so locations can be assigned flexibly per team
ALTER TABLE rounds ALTER COLUMN checkpoint_id DROP NOT NULL;
ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_event_id_checkpoint_id_key;
ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_checkpoint_id_key;

-- 4. Create team_round_locations table for assigning any location to any team for any round
CREATE TABLE IF NOT EXISTS team_round_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  round_sequence smallint NOT NULL CHECK (round_sequence BETWEEN 1 AND 16),
  checkpoint_id uuid NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, round_sequence)
);

CREATE INDEX IF NOT EXISTS team_round_locations_team_idx ON team_round_locations(team_id);
CREATE INDEX IF NOT EXISTS team_round_locations_checkpoint_idx ON team_round_locations(checkpoint_id);

-- 5. Seed team_round_locations for existing teams and rounds
INSERT INTO team_round_locations (team_id, round_sequence, checkpoint_id)
SELECT t.id, r.sequence, r.checkpoint_id
FROM teams t
JOIN rounds r ON r.event_id = t.event_id
WHERE r.checkpoint_id IS NOT NULL
ON CONFLICT (team_id, round_sequence) DO NOTHING;

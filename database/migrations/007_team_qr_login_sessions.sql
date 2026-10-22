CREATE TABLE team_checkpoint_qrs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  checkpoint_id uuid NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  qr_token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, checkpoint_id)
);

ALTER TABLE sessions ADD COLUMN scan_token_hash char(64);

-- Start the new one-player-per-team policy from a clean participant login state.
UPDATE sessions SET revoked_at=now() WHERE participant_id IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX team_checkpoint_qrs_checkpoint_idx ON team_checkpoint_qrs(checkpoint_id);

CREATE OR REPLACE FUNCTION validate_team_checkpoint_event() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM teams t
    JOIN checkpoints c ON c.event_id=t.event_id
    WHERE t.id=NEW.team_id AND c.id=NEW.checkpoint_id
  ) THEN
    RAISE EXCEPTION 'team and checkpoint must belong to the same event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER team_checkpoint_same_event
BEFORE INSERT OR UPDATE OF team_id, checkpoint_id ON team_checkpoint_qrs
FOR EACH ROW EXECUTE FUNCTION validate_team_checkpoint_event();

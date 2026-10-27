CREATE TABLE IF NOT EXISTS team_round_game_mappings (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  game_id uuid REFERENCES games(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, round_id)
);

CREATE INDEX IF NOT EXISTS team_round_game_mappings_round_idx
  ON team_round_game_mappings(round_id);

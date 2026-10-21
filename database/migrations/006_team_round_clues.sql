CREATE TABLE team_round_clues (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  clue text NOT NULL CHECK (length(btrim(clue)) BETWEEN 1 AND 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, round_id)
);

CREATE INDEX team_round_clues_round_idx ON team_round_clues(round_id);

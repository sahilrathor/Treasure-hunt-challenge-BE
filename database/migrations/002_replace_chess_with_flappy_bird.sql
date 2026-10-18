-- Migration: Replace chess-puzzle with flappy-bird
-- Disable chess-puzzle
UPDATE games SET enabled = false WHERE code = 'chess-puzzle';

-- Insert flappy-bird
INSERT INTO games (code, name, enabled) VALUES ('flappy-bird', 'Flappy Bird', true)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, enabled = true;

WITH level_values(code, difficulty, config) AS (
  VALUES
    ('flappy-bird','easy','{"target":3,"gap":135,"speed":2.2}'::jsonb),
    ('flappy-bird','medium','{"target":5,"gap":120,"speed":2.6}'::jsonb),
    ('flappy-bird','hard','{"target":8,"gap":105,"speed":3.0}'::jsonb)
)
INSERT INTO game_levels (game_id, difficulty, config, enabled)
SELECT g.id, v.difficulty, v.config, true FROM level_values v JOIN games g ON g.code = v.code
ON CONFLICT (game_id, difficulty) DO UPDATE SET config = EXCLUDED.config, enabled = true;

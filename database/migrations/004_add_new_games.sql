-- Migration: Add mini-platformer, crack-the-code, sliding-puzzle, pacman
INSERT INTO games (code, name, enabled) VALUES
  ('mini-platformer', 'Mini Platformer', true),
  ('crack-the-code', 'Crack the Code', true),
  ('sliding-puzzle', 'Sliding Puzzle', true),
  ('pacman', 'Pac-Man', true)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, enabled = true;

WITH level_values(code, difficulty, config) AS (
  VALUES
    ('mini-platformer','easy','{"target":3,"speed":3.5,"lives":3}'::jsonb),
    ('mini-platformer','medium','{"target":5,"speed":4.0,"lives":3}'::jsonb),
    ('mini-platformer','hard','{"target":8,"speed":4.5,"lives":2}'::jsonb),

    ('crack-the-code','easy','{"digits":5,"maxGuesses":6,"maxDigit":8,"allowDuplicates":true}'::jsonb),
    ('crack-the-code','medium','{"digits":6,"maxGuesses":6,"maxDigit":8,"allowDuplicates":true}'::jsonb),
    ('crack-the-code','hard','{"digits":6,"maxGuesses":5,"maxDigit":9,"allowDuplicates":true}'::jsonb),

    ('sliding-puzzle','easy','{"size":3,"scrambleMoves":12}'::jsonb),
    ('sliding-puzzle','medium','{"size":3,"scrambleMoves":25}'::jsonb),
    ('sliding-puzzle','hard','{"size":3,"scrambleMoves":45}'::jsonb),

    ('pacman','easy','{"target":25,"ghosts":1,"speed":1.8,"lives":3}'::jsonb),
    ('pacman','medium','{"target":40,"ghosts":2,"speed":2.2,"lives":3}'::jsonb),
    ('pacman','hard','{"target":60,"ghosts":3,"speed":2.6,"lives":2}'::jsonb)
)
INSERT INTO game_levels (game_id, difficulty, config)
SELECT g.id, v.difficulty, v.config FROM level_values v JOIN games g ON g.code = v.code
ON CONFLICT (game_id, difficulty) DO UPDATE SET config = EXCLUDED.config, enabled = true;

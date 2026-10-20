INSERT INTO games (code, name) VALUES
  ('tetris', 'Tetris'), ('snake', 'Snake'), ('brick-breaker', 'Brick Breaker'),
  ('memory-match', 'Memory Match'), ('number-merge', 'Number Merge'),
  ('space-invaders', 'Space Invaders'), ('pattern-recall', 'Pattern Recall'),
  ('flappy-bird', 'Flappy Bird'),
  ('mini-platformer', 'Mini Platformer'), ('crack-the-code', 'Crack the Code'),
  ('sliding-puzzle', 'Sliding Puzzle'), ('pacman', 'Pac-Man')
  -- ('chess-puzzle', 'Chess Puzzle') -- commented out per request
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

WITH level_values(code, difficulty, config) AS (
  VALUES
    ('tetris','easy','{"target":3,"speed":550}'::jsonb), ('tetris','medium','{"target":6,"speed":400}'::jsonb), ('tetris','hard','{"target":8,"speed":280}'::jsonb),
    ('snake','easy','{"target":5,"obstacles":0}'::jsonb), ('snake','medium','{"target":10,"obstacles":2}'::jsonb), ('snake','hard','{"target":15,"obstacles":5}'::jsonb),
    ('brick-breaker','easy','{"target":8,"lives":5}'::jsonb), ('brick-breaker','medium','{"target":14,"lives":4}'::jsonb), ('brick-breaker','hard','{"target":20,"lives":3}'::jsonb),
    ('memory-match','easy','{"pairs":6}'::jsonb), ('memory-match','medium','{"pairs":8}'::jsonb), ('memory-match','hard','{"pairs":12}'::jsonb),
    -- ('chess-puzzle','easy','{"moves":1}'::jsonb), ('chess-puzzle','medium','{"moves":2}'::jsonb), ('chess-puzzle','hard','{"moves":3}'::jsonb),
    ('flappy-bird','easy','{"target":3,"gap":135,"speed":2.2}'::jsonb), ('flappy-bird','medium','{"target":5,"gap":120,"speed":2.6}'::jsonb), ('flappy-bird','hard','{"target":8,"gap":105,"speed":3.0}'::jsonb),
    ('number-merge','easy','{"target":32,"maxMoves":40}'::jsonb), ('number-merge','medium','{"target":64,"maxMoves":65}'::jsonb), ('number-merge','hard','{"target":128,"maxMoves":90}'::jsonb),
    ('space-invaders','easy','{"target":8,"lives":5}'::jsonb), ('space-invaders','medium','{"target":16,"lives":4}'::jsonb), ('space-invaders','hard','{"target":24,"lives":3}'::jsonb),
    ('pattern-recall','easy','{"length":5,"palette":4}'::jsonb), ('pattern-recall','medium','{"length":8,"palette":4}'::jsonb), ('pattern-recall','hard','{"length":12,"palette":5}'::jsonb),
    ('mini-platformer','easy','{"target":3,"speed":3.5,"lives":3}'::jsonb), ('mini-platformer','medium','{"target":5,"speed":4.0,"lives":3}'::jsonb), ('mini-platformer','hard','{"target":8,"speed":4.5,"lives":2}'::jsonb),
    ('crack-the-code','easy','{"digits":3,"maxGuesses":6,"maxDigit":6,"allowDuplicates":false}'::jsonb), ('crack-the-code','medium','{"digits":4,"maxGuesses":6,"maxDigit":8,"allowDuplicates":false}'::jsonb), ('crack-the-code','hard','{"digits":4,"maxGuesses":5,"maxDigit":9,"allowDuplicates":true}'::jsonb),
    ('sliding-puzzle','easy','{"size":3,"scrambleMoves":12}'::jsonb), ('sliding-puzzle','medium','{"size":3,"scrambleMoves":25}'::jsonb), ('sliding-puzzle','hard','{"size":3,"scrambleMoves":45}'::jsonb),
    ('pacman','easy','{"target":25,"ghosts":1,"speed":1.8,"lives":3}'::jsonb), ('pacman','medium','{"target":40,"ghosts":2,"speed":2.2,"lives":3}'::jsonb), ('pacman','hard','{"target":60,"ghosts":3,"speed":2.6,"lives":2}'::jsonb)
)
INSERT INTO game_levels (game_id, difficulty, config)
SELECT g.id, v.difficulty, v.config FROM level_values v JOIN games g ON g.code = v.code
ON CONFLICT (game_id, difficulty) DO UPDATE SET config = EXCLUDED.config, enabled = true;

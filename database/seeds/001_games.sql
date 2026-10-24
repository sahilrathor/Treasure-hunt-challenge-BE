INSERT INTO games (code, name, description) VALUES
  ('tetris', 'Tetris', 'Position and rotate falling geometric tetromino blocks to form solid horizontal lines.'),
  ('snake', 'Snake', 'Steer a growing snake across the arena to devour food pellets while dodging obstacles and your own tail.'),
  ('brick-breaker', 'Brick Breaker', 'Control the bottom paddle to bounce the ball at high speed and demolish target brick formations.'),
  ('memory-match', 'Memory Match', 'Flip over face-down cards to discover and match identical hidden symbols through recall.'),
  ('number-merge', 'Number Merge', 'Slide numbered tiles across a 4x4 grid to merge equal numbers and reach the target score.'),
  ('space-invaders', 'Space Invaders', 'Pilot your defense cannon to eliminate advancing alien invaders and dodge incoming enemy laser blasts.'),
  ('pattern-recall', 'Pattern Recall', 'Watch and listen to the sequence of illuminated color sound pads and replicate it accurately.'),
  ('flappy-bird', 'Flappy Bird', 'Tap or click to flap wings, maintain altitude, and weave through pipe obstacles without crashing.'),
  ('mini-platformer', 'Mini Platformer', 'Run and jump across platforms, timing leaps over spikes to collect golden coins and reach the goal.'),
  ('crack-the-code', 'Crack the Code', 'A master vault cipher test. Use logical deduction to guess the secret numeric passcode using color hints.'),
  ('sliding-puzzle', 'Sliding Puzzle', 'Slide adjacent numbered tiles into the empty space to arrange them in sequential numerical order.'),
  ('pacman', 'Pac-Man', 'Guide Pac-Man through maze corridors, chomping glowing pellets while evading patrolling ghosts.')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

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
    ('crack-the-code','easy','{"digits":5,"maxGuesses":6,"maxDigit":8,"allowDuplicates":true}'::jsonb), ('crack-the-code','medium','{"digits":6,"maxGuesses":6,"maxDigit":8,"allowDuplicates":true}'::jsonb), ('crack-the-code','hard','{"digits":6,"maxGuesses":5,"maxDigit":9,"allowDuplicates":true}'::jsonb),
    ('sliding-puzzle','easy','{"size":3,"scrambleMoves":12}'::jsonb), ('sliding-puzzle','medium','{"size":3,"scrambleMoves":25}'::jsonb), ('sliding-puzzle','hard','{"size":3,"scrambleMoves":45}'::jsonb),
    ('pacman','easy','{"target":25,"ghosts":1,"speed":1.8,"lives":3}'::jsonb), ('pacman','medium','{"target":40,"ghosts":2,"speed":2.2,"lives":3}'::jsonb), ('pacman','hard','{"target":60,"ghosts":3,"speed":2.6,"lives":2}'::jsonb)
)
INSERT INTO game_levels (game_id, difficulty, config)
SELECT g.id, v.difficulty, v.config FROM level_values v JOIN games g ON g.code = v.code
ON CONFLICT (game_id, difficulty) DO UPDATE SET config = EXCLUDED.config, enabled = true;

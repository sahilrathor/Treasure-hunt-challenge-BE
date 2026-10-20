-- Migration: Add description to games
ALTER TABLE games ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

UPDATE games SET description = CASE code
  WHEN 'flappy-bird' THEN 'Tap or click to flap wings, maintain altitude, and weave through pipe obstacles without crashing.'
  WHEN 'snake' THEN 'Steer a growing snake across the arena to devour food pellets while dodging obstacles and your own tail.'
  WHEN 'brick-breaker' THEN 'Control the bottom paddle to bounce the ball at high speed and demolish target brick formations.'
  WHEN 'space-invaders' THEN 'Pilot your defense cannon to eliminate advancing alien invaders and dodge incoming enemy laser blasts.'
  WHEN 'tetris' THEN 'Position and rotate falling geometric tetromino blocks to form solid horizontal lines.'
  WHEN 'memory-match' THEN 'Flip over face-down cards to discover and match identical hidden symbols through recall.'
  WHEN 'number-merge' THEN 'Slide numbered tiles across a 4x4 grid to merge equal numbers and reach the target score.'
  WHEN 'pattern-recall' THEN 'Watch and listen to the sequence of illuminated color sound pads and replicate it accurately.'
  WHEN 'mini-platformer' THEN 'Run and jump across platforms, timing leaps over spikes to collect golden coins and reach the goal.'
  WHEN 'crack-the-code' THEN 'A master vault cipher test. Use logical deduction to guess the secret numeric passcode using color hints.'
  WHEN 'sliding-puzzle' THEN 'Slide adjacent numbered tiles into the empty space to arrange them in sequential numerical order.'
  WHEN 'pacman' THEN 'Guide Pac-Man through maze corridors, chomping glowing pellets while evading patrolling ghosts.'
  ELSE description
END;

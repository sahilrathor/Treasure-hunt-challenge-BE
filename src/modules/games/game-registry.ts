import { HttpError } from '../../utils/http-error.js';
import { brickBreakerModule } from './brick-breaker/brick-breaker.validator.js';
// Chess puzzle commented out per request - replaced by Flappy Bird
// import { chessPuzzleModule } from './chess-puzzle/chess-puzzle.validator.js';
import { crackTheCodeModule } from './crack-the-code/crack-the-code.validator.js';
import { flappyBirdModule } from './flappy-bird/flappy-bird.validator.js';
import { memoryMatchModule } from './memory-match/memory-match.validator.js';
import { miniPlatformerModule } from './mini-platformer/mini-platformer.validator.js';
import { numberMergeModule } from './number-merge/number-merge.validator.js';
import { pacmanModule } from './pacman/pacman.validator.js';
import { patternRecallModule } from './pattern-recall/pattern-recall.validator.js';
import type { GameModule } from './shared/game.types.js';
import { slidingPuzzleModule } from './sliding-puzzle/sliding-puzzle.validator.js';
import { snakeModule } from './snake/snake.validator.js';
import { spaceInvadersModule } from './space-invaders/space-invaders.validator.js';
import { tetrisModule } from './tetris/tetris.validator.js';

export const gameRegistry = new Map<string, GameModule>(
  [
    tetrisModule,
    snakeModule,
    brickBreakerModule,
    memoryMatchModule,
    flappyBirdModule,
    // chessPuzzleModule,
    numberMergeModule,
    spaceInvadersModule,
    patternRecallModule,
    miniPlatformerModule,
    crackTheCodeModule,
    slidingPuzzleModule,
    pacmanModule,
  ].map((module) => [module.code, module]),
);

export function getGameModule(code: string) {
  const module = gameRegistry.get(code);
  if (!module) throw new HttpError(422, 'UNKNOWN_GAME', 'The assigned game is unavailable.');
  return module;
}

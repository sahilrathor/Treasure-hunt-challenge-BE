import { HttpError } from '../../utils/http-error.js';
import { brickBreakerModule } from './brick-breaker/brick-breaker.validator.js';
import { chessPuzzleModule } from './chess-puzzle/chess-puzzle.validator.js';
import type { GameModule } from './shared/game.types.js';
import { memoryMatchModule } from './memory-match/memory-match.validator.js';
import { numberMergeModule } from './number-merge/number-merge.validator.js';
import { patternRecallModule } from './pattern-recall/pattern-recall.validator.js';
import { snakeModule } from './snake/snake.validator.js';
import { spaceInvadersModule } from './space-invaders/space-invaders.validator.js';
import { tetrisModule } from './tetris/tetris.validator.js';

export const gameRegistry = new Map<string, GameModule>(
  [
    tetrisModule,
    snakeModule,
    brickBreakerModule,
    memoryMatchModule,
    chessPuzzleModule,
    numberMergeModule,
    spaceInvadersModule,
    patternRecallModule,
  ].map((module) => [module.code, module]),
);

export function getGameModule(code: string) {
  const module = gameRegistry.get(code);
  if (!module) throw new HttpError(422, 'UNKNOWN_GAME', 'The assigned game is unavailable.');
  return module;
}

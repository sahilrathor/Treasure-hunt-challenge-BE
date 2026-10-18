import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { GameModule } from '../shared/game.types.js';

const configSchema = z.object({
  target: z.number().int().min(1).max(50),
  obstacles: z.number().int().min(0).max(8),
});
const directionSchema = z.enum(['up', 'down', 'left', 'right']);
type Direction = z.infer<typeof directionSchema>;
const width = 8;
const obstacleCells = [10, 13, 18, 45, 50, 53, 29, 34];
const opposite: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

function foodFor(score: number, snake: number[], obstacles: number[]) {
  let cell = (score * 17 + 7) % 64;
  while (snake.includes(cell) || obstacles.includes(cell)) cell = (cell + 11) % 64;
  return cell;
}

export function replaySnake(actions: Direction[], obstacleCount: number) {
  let snake = [27, 26, 25];
  const obstacles = obstacleCells.slice(0, obstacleCount);
  let direction: Direction = 'right';
  let score = 0;
  let food = foodFor(score, snake, obstacles);
  for (const requested of actions) {
    direction = requested === opposite[direction] ? direction : requested;
    const head = snake[0]!;
    const row = Math.floor(head / width);
    const column = head % width;
    const nextRow = row + (direction === 'down' ? 1 : direction === 'up' ? -1 : 0);
    const nextColumn = column + (direction === 'right' ? 1 : direction === 'left' ? -1 : 0);
    if (nextRow < 0 || nextRow >= width || nextColumn < 0 || nextColumn >= width) break;
    const nextHead = nextRow * width + nextColumn;
    const ate = nextHead === food;
    const body = ate ? snake : snake.slice(0, -1);
    if (body.includes(nextHead) || obstacles.includes(nextHead)) break;
    snake = [nextHead, ...body];
    if (ate) {
      score += 1;
      food = foodFor(score, snake, obstacles);
    }
  }
  return score;
}

export const snakeModule: GameModule = {
  code: 'snake',
  createChallenge(config, difficulty) {
    const parsed = configSchema.parse(config);
    const binding = createChallengeBinding();
    return {
      publicData: { ...parsed, difficulty, challengeToken: binding.token },
      secretData: { tokenHash: binding.tokenHash },
    };
  },
  validate(config, _publicChallenge, secretChallenge, submission) {
    const parsedConfig = configSchema.parse(config);
    const secret = z.object({ tokenHash: z.string() }).parse(secretChallenge);
    const parsed = z
      .object({
        challengeToken: z.string(),
        achieved: z.number().int().nonnegative(),
        actions: z.array(directionSchema).max(2_000),
      })
      .safeParse(submission);
    if (!parsed.success)
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The Snake result is malformed.');
    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash))
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    const score = replaySnake(parsed.data.actions, parsedConfig.obstacles);
    return { passed: score >= parsedConfig.target, metadata: { foodCollected: score } };
  },
};

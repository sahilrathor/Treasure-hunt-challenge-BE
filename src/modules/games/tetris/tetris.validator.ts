import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { GameModule } from '../shared/game.types.js';

const configSchema = z.object({
  target: z.number().int().min(1).max(20),
  speed: z.number().optional(),
});
const width = 6;
const height = 10;

export function replayTetris(actions: string[]) {
  let board = Array<boolean>(width * height).fill(false);
  let lines = 0;
  for (const action of actions) {
    const match = /^drop:([0-5])$/.exec(action);
    if (!match) continue;
    const column = Number(match[1]);
    let placed = false;
    for (let row = height - 1; row >= 0; row -= 1) {
      const index = row * width + column;
      if (!board[index]) {
        board[index] = true;
        placed = true;
        break;
      }
    }
    if (!placed) break;
    const rows: boolean[][] = [];
    for (let row = 0; row < height; row += 1) {
      const values = board.slice(row * width, (row + 1) * width);
      if (values.every(Boolean)) lines += 1;
      else rows.push(values);
    }
    while (rows.length < height) rows.unshift(Array<boolean>(width).fill(false));
    board = rows.flat();
  }
  return lines;
}

export const tetrisModule: GameModule = {
  code: 'tetris',
  createChallenge(config, difficulty) {
    const parsed = configSchema.parse(config);
    const binding = createChallengeBinding();
    return {
      publicData: { ...parsed, difficulty, challengeToken: binding.token },
      secretData: { tokenHash: binding.tokenHash },
    };
  },
  validate(config, _publicChallenge, secretChallenge, submission) {
    const { target } = configSchema.parse(config);
    const secret = z.object({ tokenHash: z.string() }).parse(secretChallenge);
    const parsed = z
      .object({
        challengeToken: z.string(),
        achieved: z.number().int(),
        actions: z.array(z.string()).max(500),
      })
      .safeParse(submission);
    if (!parsed.success)
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The Tetris result is malformed.');
    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash))
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    const lines = replayTetris(parsed.data.actions);
    return {
      passed: lines >= target,
      metadata: { lines, actionCount: parsed.data.actions.length },
    };
  },
};

import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { GameModule } from '../shared/game.types.js';

const configSchema = z.object({ pairs: z.number().int().min(2).max(20) });

function shuffledBoard(pairs: number, seed: string) {
  const board = Array.from({ length: pairs * 2 }, (_, index) => Math.floor(index / 2));
  let state = [...seed].reduce((total, character) => total + character.charCodeAt(0), 0);
  for (let index = board.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const swapIndex = state % (index + 1);
    [board[index], board[swapIndex]] = [board[swapIndex]!, board[index]!];
  }
  return board;
}

export const memoryMatchModule: GameModule = {
  code: 'memory-match',
  createChallenge(config) {
    const { pairs } = configSchema.parse(config);
    const binding = createChallengeBinding();
    return {
      publicData: {
        pairs,
        board: shuffledBoard(pairs, binding.token),
        challengeToken: binding.token,
      },
      secretData: { tokenHash: binding.tokenHash },
    };
  },
  validate(config, publicChallenge, secretChallenge, submission) {
    const { pairs } = configSchema.parse(config);
    const challenge = z
      .object({ board: z.array(z.number().int()), challengeToken: z.string() })
      .parse(publicChallenge);
    const secret = z.object({ tokenHash: z.string() }).parse(secretChallenge);
    const parsed = z
      .object({
        challengeToken: z.string(),
        matches: z.array(z.tuple([z.number().int(), z.number().int()])).max(20),
      })
      .safeParse(submission);
    if (!parsed.success)
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The memory result is malformed.');
    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash))
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    const used = new Set<number>();
    const valid = parsed.data.matches.every(([left, right]) => {
      if (
        left === right ||
        used.has(left) ||
        used.has(right) ||
        challenge.board[left] === undefined
      )
        return false;
      used.add(left);
      used.add(right);
      return challenge.board[left] === challenge.board[right];
    });
    return {
      passed: valid && parsed.data.matches.length === pairs,
      metadata: { matchedPairs: parsed.data.matches.length },
    };
  },
};

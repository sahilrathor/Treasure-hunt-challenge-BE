import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { Difficulty, GameModule } from '../shared/game.types.js';

const puzzles: Record<Difficulty, { fen: string; solution: string[] }> = {
  easy: { fen: '4r1k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1', solution: ['e1-e8'] },
  medium: { fen: '6k1/5ppp/8/8/8/2Q5/5PPP/6K1 w - - 0 1', solution: ['c3-c8', 'c8-e8'] },
  hard: { fen: '5rk1/6pp/8/8/8/3Q4/6PP/6K1 w - - 0 1', solution: ['d3-c4', 'c4-f7', 'f7-f8'] },
};

export const chessPuzzleModule: GameModule = {
  code: 'chess-puzzle',
  createChallenge(_config, difficulty) {
    const puzzle = puzzles[difficulty];
    const binding = createChallengeBinding();
    return {
      publicData: {
        fen: puzzle.fen,
        moveCount: puzzle.solution.length,
        challengeToken: binding.token,
      },
      secretData: { solution: puzzle.solution, tokenHash: binding.tokenHash },
    };
  },
  validate(_config, _publicChallenge, secretChallenge, submission) {
    const secret = z
      .object({ solution: z.array(z.string()), tokenHash: z.string() })
      .parse(secretChallenge);
    const parsed = z
      .object({
        challengeToken: z.string(),
        moves: z.array(z.string().regex(/^[a-h][1-8]-[a-h][1-8]$/)).max(5),
      })
      .safeParse(submission);
    if (!parsed.success)
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The chess result is malformed.');
    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash))
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    const correct =
      parsed.data.moves.length === secret.solution.length &&
      parsed.data.moves.every((move, index) => move === secret.solution[index]);
    return { passed: correct, metadata: { moves: parsed.data.moves } };
  },
};

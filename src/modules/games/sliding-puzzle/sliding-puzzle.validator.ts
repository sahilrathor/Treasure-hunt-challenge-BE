import { randomInt } from 'node:crypto';
import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { Difficulty, GameModule } from '../shared/game.types.js';

const configSchema = z.object({
  size: z.number().int().min(3).max(4).default(3),
  scrambleMoves: z.number().int().min(5).max(100).default(15),
});

const defaultTargets: Record<Difficulty, { size: number; scrambleMoves: number }> = {
  easy: { size: 3, scrambleMoves: 12 },
  medium: { size: 3, scrambleMoves: 25 },
  hard: { size: 3, scrambleMoves: 45 },
};

function generateSolvableScramble(size: number, movesCount: number): number[] {
  // Start from solved state: 1, 2, ..., size*size-1, 0 (0 is empty)
  const total = size * size;
  const tiles = Array.from({ length: total }, (_, i) => (i + 1) % total);
  let emptyIdx = total - 1;

  let lastMove = -1;
  for (let m = 0; m < movesCount; m++) {
    const row = Math.floor(emptyIdx / size);
    const col = emptyIdx % size;
    const validMoves: number[] = [];

    if (row > 0) validMoves.push(emptyIdx - size); // tile above can slide down
    if (row < size - 1) validMoves.push(emptyIdx + size); // tile below can slide up
    if (col > 0) validMoves.push(emptyIdx - 1); // tile left can slide right
    if (col < size - 1) validMoves.push(emptyIdx + 1); // tile right can slide left

    // Avoid immediately undoing last move
    const candidates = validMoves.filter((idx) => idx !== lastMove);
    const chosenIdx = candidates.length > 0 ? candidates[randomInt(candidates.length)]! : validMoves[0]!;

    tiles[emptyIdx] = tiles[chosenIdx]!;
    tiles[chosenIdx] = 0;
    lastMove = emptyIdx;
    emptyIdx = chosenIdx;
  }

  return tiles;
}

export const slidingPuzzleModule: GameModule = {
  code: 'sliding-puzzle',
  createChallenge(config, difficulty) {
    const fallback = defaultTargets[difficulty] ?? defaultTargets.easy;
    const parsed = configSchema.safeParse(config);
    const resolved = parsed.success ? parsed.data : fallback;

    const initialTiles = generateSolvableScramble(resolved.size, resolved.scrambleMoves);
    const binding = createChallengeBinding();

    return {
      publicData: {
        size: resolved.size,
        scrambleMoves: resolved.scrambleMoves,
        initialTiles,
        difficulty,
        challengeToken: binding.token,
      },
      secretData: {
        initialTiles,
        size: resolved.size,
        tokenHash: binding.tokenHash,
      },
    };
  },
  validate(_config, _publicChallenge, secretChallenge, submission) {
    const secret = z
      .object({
        initialTiles: z.array(z.number().int()),
        size: z.number().int().default(3),
        tokenHash: z.string(),
      })
      .parse(secretChallenge);

    const parsed = z
      .object({
        challengeToken: z.string(),
        moves: z.array(z.number().int()).max(500),
        finalTiles: z.array(z.number().int()).optional(),
      })
      .safeParse(submission);

    if (!parsed.success) {
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The Sliding Puzzle result is malformed.');
    }

    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash)) {
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    }

    // Replay moves from initialTiles
    const size = secret.size;
    const total = size * size;
    const board = [...secret.initialTiles];
    let emptyIdx = board.indexOf(0);

    for (const tileIdx of parsed.data.moves) {
      if (tileIdx < 0 || tileIdx >= total) {
        return { passed: false, metadata: { reason: 'Invalid tile index' } };
      }
      const emptyRow = Math.floor(emptyIdx / size);
      const emptyCol = emptyIdx % size;
      const tileRow = Math.floor(tileIdx / size);
      const tileCol = tileIdx % size;

      // Check adjacency
      const isAdjacent = Math.abs(emptyRow - tileRow) + Math.abs(emptyCol - tileCol) === 1;
      if (!isAdjacent) {
        return { passed: false, metadata: { reason: 'Non-adjacent slide attempted' } };
      }

      // Swap
      board[emptyIdx] = board[tileIdx]!;
      board[tileIdx] = 0;
      emptyIdx = tileIdx;
    }

    // Check if solved: 1, 2, ..., total-1, 0
    const isSolved = board.every((tile, idx) => tile === (idx + 1) % total);

    return {
      passed: isSolved,
      metadata: {
        movesCount: parsed.data.moves.length,
        isSolved,
      },
    };
  },
};

import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { GameModule } from '../shared/game.types.js';

const configSchema = z.object({
  target: z.number().int().min(8).max(2048),
  maxMoves: z.number().int().min(1).max(500),
});
const directions = z.enum(['up', 'down', 'left', 'right']);

export function replayMerge(moves: string[]) {
  let board = [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let acceptedMoves = 0;
  for (const rawDirection of moves) {
    const parsed = directions.safeParse(rawDirection);
    if (!parsed.success) continue;
    const direction = parsed.data;
    const next = [...board];
    for (let line = 0; line < 4; line += 1) {
      const indexes = Array.from({ length: 4 }, (_, offset) => {
        if (direction === 'left') return line * 4 + offset;
        if (direction === 'right') return line * 4 + (3 - offset);
        if (direction === 'up') return offset * 4 + line;
        return (3 - offset) * 4 + line;
      });
      const values = indexes.map((index) => board[index]!).filter(Boolean);
      const merged: number[] = [];
      for (let index = 0; index < values.length; index += 1) {
        if (values[index] === values[index + 1]) {
          merged.push(values[index]! * 2);
          index += 1;
        } else {
          merged.push(values[index]!);
        }
      }
      const collapsed = [...merged, ...Array<number>(4 - merged.length).fill(0)];
      indexes.forEach((index, offset) => {
        next[index] = collapsed[offset]!;
      });
    }
    if (next.every((value, index) => value === board[index])) continue;
    acceptedMoves += 1;
    const empty = next
      .map((value, index) => (value === 0 ? index : -1))
      .filter((index) => index >= 0);
    if (empty.length) {
      const position = empty[(acceptedMoves * 7 + 3) % empty.length]!;
      next[position] = acceptedMoves % 7 === 0 ? 4 : 2;
    }
    board = next;
  }
  return Math.max(...board);
}

export const numberMergeModule: GameModule = {
  code: 'number-merge',
  createChallenge(config) {
    const parsed = configSchema.parse(config);
    const binding = createChallengeBinding();
    return {
      publicData: {
        target: parsed.target,
        maxMoves: parsed.maxMoves,
        initialValue: 2,
        challengeToken: binding.token,
      },
      secretData: { tokenHash: binding.tokenHash },
    };
  },
  validate(config, _publicChallenge, secretChallenge, submission) {
    const parsedConfig = configSchema.parse(config);
    const secret = z.object({ tokenHash: z.string() }).parse(secretChallenge);
    const parsed = z
      .object({ challengeToken: z.string(), moves: z.array(directions).max(500) })
      .safeParse(submission);
    if (!parsed.success)
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The number merge result is malformed.');
    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash))
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    const peak = replayMerge(parsed.data.moves);
    return {
      passed: parsed.data.moves.length <= parsedConfig.maxMoves && peak >= parsedConfig.target,
      metadata: { peak, moveCount: parsed.data.moves.length },
    };
  },
};

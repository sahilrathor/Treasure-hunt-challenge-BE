import { randomInt } from 'node:crypto';
import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { Difficulty, GameModule } from '../shared/game.types.js';

const configSchema = z.object({
  digits: z.number().int().min(3).max(6).default(4),
  maxGuesses: z.number().int().min(3).max(10).default(6),
  maxDigit: z.number().int().min(4).max(9).default(8),
  allowDuplicates: z.boolean().default(false),
});

const defaultTargets: Record<
  Difficulty,
  { digits: number; maxGuesses: number; maxDigit: number; allowDuplicates: boolean }
> = {
  easy: { digits: 3, maxGuesses: 6, maxDigit: 6, allowDuplicates: false },
  medium: { digits: 4, maxGuesses: 6, maxDigit: 8, allowDuplicates: false },
  hard: { digits: 4, maxGuesses: 5, maxDigit: 9, allowDuplicates: true },
};

export const crackTheCodeModule: GameModule = {
  code: 'crack-the-code',
  createChallenge(config, difficulty) {
    const fallback = defaultTargets[difficulty] ?? defaultTargets.easy;
    const parsed = configSchema.safeParse(config);
    const resolved = parsed.success ? parsed.data : fallback;

    // Generate random secret code
    const code: number[] = [];
    if (!resolved.allowDuplicates) {
      const pool = Array.from({ length: resolved.maxDigit }, (_, i) => i + 1);
      for (let i = 0; i < resolved.digits; i++) {
        const idx = randomInt(pool.length);
        code.push(pool.splice(idx, 1)[0]!);
      }
    } else {
      for (let i = 0; i < resolved.digits; i++) {
        code.push(randomInt(resolved.maxDigit + 1));
      }
    }

    const binding = createChallengeBinding();

    return {
      publicData: {
        code,
        digits: resolved.digits,
        maxGuesses: resolved.maxGuesses,
        maxDigit: resolved.maxDigit,
        allowDuplicates: resolved.allowDuplicates,
        difficulty,
        challengeToken: binding.token,
      },
      secretData: {
        code,
        tokenHash: binding.tokenHash,
      },
    };
  },
  validate(_config, _publicChallenge, secretChallenge, submission) {
    const secret = z
      .object({ code: z.array(z.number().int()), tokenHash: z.string() })
      .parse(secretChallenge);

    const parsed = z
      .object({
        challengeToken: z.string(),
        guesses: z.array(z.array(z.number().int())).min(1).max(20),
        solved: z.boolean().optional(),
      })
      .safeParse(submission);

    if (!parsed.success) {
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The Crack the Code result is malformed.');
    }

    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash)) {
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    }

    const lastGuess = parsed.data.guesses[parsed.data.guesses.length - 1];
    const isCorrect =
      lastGuess &&
      lastGuess.length === secret.code.length &&
      lastGuess.every((val, idx) => val === secret.code[idx]);

    return {
      passed: Boolean(isCorrect),
      metadata: {
        totalGuesses: parsed.data.guesses.length,
        solved: isCorrect,
      },
    };
  },
};

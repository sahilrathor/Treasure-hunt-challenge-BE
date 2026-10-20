import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { Difficulty, GameModule } from '../shared/game.types.js';

const configSchema = z.object({
  target: z.number().int().positive().max(30).default(3),
  speed: z.number().positive().max(10).default(3.5),
  lives: z.number().int().min(1).max(5).default(3),
});

const defaultTargets: Record<Difficulty, { target: number; speed: number; lives: number }> = {
  easy: { target: 3, speed: 3.5, lives: 3 },
  medium: { target: 5, speed: 4.0, lives: 3 },
  hard: { target: 8, speed: 4.5, lives: 2 },
};

export const miniPlatformerModule: GameModule = {
  code: 'mini-platformer',
  createChallenge(config, difficulty) {
    const fallback = defaultTargets[difficulty] ?? defaultTargets.easy;
    const parsed = configSchema.safeParse(config);
    const resolved = parsed.success ? parsed.data : fallback;
    const binding = createChallengeBinding();

    return {
      publicData: {
        ...resolved,
        difficulty,
        challengeToken: binding.token,
      },
      secretData: {
        target: resolved.target,
        tokenHash: binding.tokenHash,
      },
    };
  },
  validate(config, _publicChallenge, secretChallenge, submission) {
    const fallback = defaultTargets.easy;
    const parsedConfig = configSchema.safeParse(config);
    const resolved = parsedConfig.success ? parsedConfig.data : fallback;

    const secret = z
      .object({ target: z.number().int().positive(), tokenHash: z.string() })
      .parse(secretChallenge);

    const parsed = z
      .object({
        challengeToken: z.string(),
        achieved: z.number().int().optional(),
        coinsCollected: z.number().int().optional(),
        actions: z.array(z.string()).max(1000),
        livesRemaining: z.number().int().min(1).optional(),
      })
      .safeParse(submission);

    if (!parsed.success) {
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The Mini Platformer result is malformed.');
    }

    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash)) {
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    }

    const coinsCollected = new Set(
      parsed.data.actions
        .map((action) => /^coin:(\d+)$/.exec(action))
        .filter((match): match is RegExpExecArray => Boolean(match))
        .map((match) => Number(match[1])),
    );

    const hasReachedGoal = parsed.data.actions.some((a) => a === 'goal' || a.startsWith('goal:'));
    const score = parsed.data.achieved ?? parsed.data.coinsCollected ?? coinsCollected.size;
    const requiredTarget = secret.target || resolved.target;

    const passed = score >= requiredTarget && (hasReachedGoal || coinsCollected.size >= requiredTarget);

    return {
      passed,
      metadata: {
        coinsCollected: coinsCollected.size,
        hasReachedGoal,
        actionsCount: parsed.data.actions.length,
      },
    };
  },
};

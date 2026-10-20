import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { Difficulty, GameModule } from '../shared/game.types.js';

const configSchema = z.object({
  target: z.number().int().positive().max(100).default(25),
  ghosts: z.number().int().min(1).max(4).default(1),
  speed: z.number().positive().max(10).default(1.8),
  lives: z.number().int().min(1).max(5).default(3),
});

const defaultTargets: Record<
  Difficulty,
  { target: number; ghosts: number; speed: number; lives: number }
> = {
  easy: { target: 25, ghosts: 1, speed: 1.8, lives: 3 },
  medium: { target: 40, ghosts: 2, speed: 2.2, lives: 3 },
  hard: { target: 60, ghosts: 3, speed: 2.6, lives: 2 },
};

export const pacmanModule: GameModule = {
  code: 'pacman',
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
        pelletsEaten: z.number().int().optional(),
        actions: z.array(z.string()).max(1000),
        livesRemaining: z.number().int().min(1).optional(),
      })
      .safeParse(submission);

    if (!parsed.success) {
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The Pac-Man result is malformed.');
    }

    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash)) {
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    }

    const pellets = new Set(
      parsed.data.actions
        .map((action) => /^pellet:(\d+)$/.exec(action))
        .filter((match): match is RegExpExecArray => Boolean(match))
        .map((match) => Number(match[1])),
    );

    const score = parsed.data.achieved ?? parsed.data.pelletsEaten ?? pellets.size;
    const requiredTarget = secret.target || resolved.target;

    const passed = score >= requiredTarget && pellets.size >= requiredTarget;

    return {
      passed,
      metadata: {
        pelletsEaten: pellets.size,
        claimedScore: score,
        actionsCount: parsed.data.actions.length,
      },
    };
  },
};

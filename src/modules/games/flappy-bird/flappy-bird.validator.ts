import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { Difficulty, GameModule } from '../shared/game.types.js';

const configSchema = z.object({
  target: z.number().int().positive().max(50).default(3),
  gap: z.number().int().positive().max(200).default(120),
  speed: z.number().positive().max(10).default(2.4),
});

const defaultTargets: Record<Difficulty, { target: number; gap: number; speed: number }> = {
  easy: { target: 3, gap: 135, speed: 2.2 },
  medium: { target: 5, gap: 120, speed: 2.6 },
  hard: { target: 8, gap: 105, speed: 3.0 },
};

export const flappyBirdModule: GameModule = {
  code: 'flappy-bird',
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
        score: z.number().int().optional(),
        actions: z.array(z.string()).max(1000),
      })
      .safeParse(submission);

    if (!parsed.success) {
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The Flappy Bird result is malformed.');
    }

    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash)) {
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    }

    const passedPipes = new Set(
      parsed.data.actions
        .map((action) => /^pass:(\d+)$/.exec(action))
        .filter((match): match is RegExpExecArray => Boolean(match))
        .map((match) => Number(match[1])),
    );

    const claimedScore = parsed.data.achieved ?? parsed.data.score ?? passedPipes.size;
    const requiredTarget = secret.target || resolved.target;

    const passed = claimedScore >= requiredTarget && passedPipes.size >= requiredTarget;

    return {
      passed,
      metadata: {
        pipesPassed: passedPipes.size,
        claimedScore,
        actionsCount: parsed.data.actions.length,
      },
    };
  },
};

import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { GameModule } from '../shared/game.types.js';

const configSchema = z.object({
  target: z.number().int().positive().max(100),
  lives: z.number().int().positive().max(20),
});

export const spaceInvadersModule: GameModule = {
  code: 'space-invaders',
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
      .object({ challengeToken: z.string(), actions: z.array(z.string()).max(500) })
      .passthrough()
      .safeParse(submission);
    if (!parsed.success)
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The Space Invaders result is malformed.');
    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash))
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    const destroyed = new Set(
      parsed.data.actions
        .map((action) => /^fire:(\d+)$/.exec(action))
        .filter((match): match is RegExpExecArray => Boolean(match))
        .map((match) => Number(match[1]))
        .filter((enemy) => enemy >= 0 && enemy < parsedConfig.target),
    );
    return {
      passed: destroyed.size === parsedConfig.target,
      metadata: { enemiesDestroyed: destroyed.size, shots: parsed.data.actions.length },
    };
  },
};

import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { GameModule } from '../shared/game.types.js';

const configSchema = z.object({
  target: z.number().int().positive().max(100),
  lives: z.number().int().positive().max(20),
});

export const brickBreakerModule: GameModule = {
  code: 'brick-breaker',
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
      .object({
        challengeToken: z.string(),
        actions: z.array(z.string()).max(500),
        livesRemaining: z.number().int().nonnegative(),
      })
      .safeParse(submission);
    if (!parsed.success)
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The Brick Breaker result is malformed.');
    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash))
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    const hits = new Set(
      parsed.data.actions
        .map((action) => /^hit:(\d+)$/.exec(action))
        .filter((match): match is RegExpExecArray => Boolean(match))
        .map((match) => Number(match[1]))
        .filter((brick) => brick >= 0 && brick < parsedConfig.target),
    );
    const passed =
      hits.size === parsedConfig.target && parsed.data.livesRemaining <= parsedConfig.lives;
    return {
      passed,
      metadata: { bricksBroken: hits.size, livesRemaining: parsed.data.livesRemaining },
    };
  },
};

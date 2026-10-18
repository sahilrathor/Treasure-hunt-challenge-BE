import { randomInt } from 'node:crypto';
import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { GameModule } from '../shared/game.types.js';

const configSchema = z.object({
  length: z.number().int().min(3).max(30),
  palette: z.number().int().min(2).max(8),
});

export const patternRecallModule: GameModule = {
  code: 'pattern-recall',
  createChallenge(config, difficulty) {
    const parsed = configSchema.parse(config);
    const sequence = Array.from({ length: parsed.length }, () => randomInt(parsed.palette));
    const binding = createChallengeBinding();
    return {
      publicData: {
        length: parsed.length,
        palette: parsed.palette,
        difficulty,
        sequence,
        challengeToken: binding.token,
      },
      secretData: { sequence, tokenHash: binding.tokenHash },
    };
  },
  validate(config, _publicChallenge, secretChallenge, submission) {
    const { length } = configSchema.parse(config);
    const secret = z
      .object({ sequence: z.array(z.number().int()), tokenHash: z.string() })
      .parse(secretChallenge);
    const parsed = z
      .object({ challengeToken: z.string(), sequence: z.array(z.number().int()).max(30) })
      .safeParse(submission);
    if (!parsed.success)
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The pattern result is malformed.');
    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash))
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    const correct =
      parsed.data.sequence.length === length &&
      parsed.data.sequence.every((value, index) => value === secret.sequence[index]);
    return { passed: correct, metadata: { submittedSteps: parsed.data.sequence.length } };
  },
};

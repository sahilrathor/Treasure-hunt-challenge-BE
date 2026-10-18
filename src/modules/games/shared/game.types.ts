export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Challenge {
  publicData: Record<string, unknown>;
  secretData: Record<string, unknown>;
}

export interface ValidationResult {
  passed: boolean;
  metadata: Record<string, unknown>;
}

export interface GameModule {
  code: string;
  createChallenge(config: unknown, difficulty: Difficulty): Challenge;
  validate(
    config: unknown,
    publicChallenge: unknown,
    secretChallenge: unknown,
    submission: unknown,
  ): ValidationResult;
}

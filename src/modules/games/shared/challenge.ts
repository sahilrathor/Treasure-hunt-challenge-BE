import { createToken, hashToken } from '../../../utils/crypto.js';

export function createChallengeBinding() {
  const token = createToken(18);
  return { token, tokenHash: hashToken(token) };
}

export function verifyChallengeBinding(token: string, tokenHash: string) {
  return hashToken(token) === tokenHash;
}

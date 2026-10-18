import { gameRegistry } from '../../src/modules/games/game-registry.js';

const cases = [
  {
    code: 'tetris',
    config: { target: 2 },
    result: (challenge: Record<string, unknown>) => ({
      challengeToken: challenge.challengeToken,
      achieved: 2,
      actions: Array.from({ length: 12 }, (_, index) => `drop:${index % 6}`),
    }),
  },
  {
    code: 'snake',
    config: { target: 1, obstacles: 0 },
    result: (challenge: Record<string, unknown>) => ({
      challengeToken: challenge.challengeToken,
      achieved: 1,
      actions: ['right', 'right', 'right', 'right', 'up', 'up', 'up'],
    }),
  },
  {
    code: 'brick-breaker',
    config: { target: 2, lives: 3 },
    result: (challenge: Record<string, unknown>) => ({
      challengeToken: challenge.challengeToken,
      achieved: 2,
      actions: ['hit:0', 'hit:1'],
      livesRemaining: 2,
    }),
  },
  {
    code: 'space-invaders',
    config: { target: 2, lives: 3 },
    result: (challenge: Record<string, unknown>) => ({
      challengeToken: challenge.challengeToken,
      achieved: 2,
      actions: ['fire:0', 'fire:1'],
      livesRemaining: 2,
    }),
  },
  {
    code: 'flappy-bird',
    config: { target: 2, gap: 120, speed: 2.4 },
    result: (challenge: Record<string, unknown>) => ({
      challengeToken: challenge.challengeToken,
      achieved: 2,
      score: 2,
      actions: ['flap', 'pass:0', 'flap', 'pass:1'],
    }),
  },
] as const;

describe('arcade game validators', () => {
  it.each(cases)('validates evidence for $code', ({ code, config, result }) => {
    const module = gameRegistry.get(code)!;
    const challenge = module.createChallenge(config, 'easy');
    expect(
      module.validate(
        config,
        challenge.publicData,
        challenge.secretData,
        result(challenge.publicData),
      ).passed,
    ).toBe(true);
    expect(
      module.validate(config, challenge.publicData, challenge.secretData, {
        ...result(challenge.publicData),
        achieved: 0,
        actions: [],
      }).passed,
    ).toBe(false);
  });
});

describe('deterministic game validators', () => {
  it('validates a complete memory match without duplicate cards', () => {
    const module = gameRegistry.get('memory-match')!;
    const config = { pairs: 4 };
    const challenge = module.createChallenge(config, 'easy');
    const board = challenge.publicData.board as number[];
    const matches = [...new Set(board)].map((value) => {
      const indexes = board.flatMap((card, index) => (card === value ? [index] : []));
      return [indexes[0], indexes[1]] as [number, number];
    });
    expect(
      module.validate(config, challenge.publicData, challenge.secretData, {
        challengeToken: challenge.publicData.challengeToken,
        matches,
      }).passed,
    ).toBe(true);
  });

  it('validates the server-held pattern sequence', () => {
    const module = gameRegistry.get('pattern-recall')!;
    const config = { length: 5, palette: 4 };
    const challenge = module.createChallenge(config, 'easy');
    expect(
      module.validate(config, challenge.publicData, challenge.secretData, {
        challengeToken: challenge.publicData.challengeToken,
        sequence: challenge.secretData.sequence,
      }).passed,
    ).toBe(true);
  });

  // chess-puzzle commented out per request - replaced by Flappy Bird
  // it('validates the server-held chess solution', () => {
  //   const module = gameRegistry.get('chess-puzzle')!;
  //   const challenge = module.createChallenge({ moves: 1 }, 'easy');
  //   expect(
  //     module.validate({}, challenge.publicData, challenge.secretData, {
  //       challengeToken: challenge.publicData.challengeToken,
  //       moves: challenge.secretData.solution,
  //     }).passed,
  //   ).toBe(true);
  // });

  it('replays number merge moves instead of trusting a claimed board', () => {
    const module = gameRegistry.get('number-merge')!;
    const config = { target: 32, maxMoves: 40 };
    const challenge = module.createChallenge(config, 'easy');
    const moves = Array.from(
      { length: 25 },
      (_, index) => (['left', 'down', 'right', 'up'] as const)[index % 4],
    );
    expect(
      module.validate(config, challenge.publicData, challenge.secretData, {
        challengeToken: challenge.publicData.challengeToken,
        moves,
      }).passed,
    ).toBe(true);
    expect(
      module.validate(config, challenge.publicData, challenge.secretData, {
        challengeToken: challenge.publicData.challengeToken,
        moves: ['left'],
      }).passed,
    ).toBe(false);
  });
});

it('registers exactly the eight supported game codes', () => {
  expect([...gameRegistry.keys()].sort()).toEqual([
    'brick-breaker',
    'flappy-bird',
    'memory-match',
    'number-merge',
    'pattern-recall',
    'snake',
    'space-invaders',
    'tetris',
  ]);
});

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import * as db from '../../src/db/pool.js';
import { crackTheCodeModule } from '../../src/modules/games/crack-the-code/crack-the-code.validator.js';

vi.mock('../../src/db/pool.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn(), end: vi.fn() },
}));

const result = (rows: unknown[], rowCount = rows.length) =>
  ({ rows, command: 'SELECT', rowCount, oid: 0, fields: [] }) as never;

const participantSession = {
  session_id: 'session-player-1',
  user_id: '11111111-1111-4111-8111-111111111111',
  role: 'PARTICIPANT',
  display_name: 'Rohit Sharma',
  member_code: 'ROHIT-1',
  event_id: '22222222-2222-4222-8222-222222222222',
  team_id: '33333333-3333-4333-8333-333333333333',
};

describe('offline attempt submission and duration handling', () => {
  const app = createApp({ logLevel: 'silent' });
  const attemptId = '44444444-4444-4444-8444-444444444444';

  beforeEach(() => vi.clearAllMocks());

  it('records clientDurationMs and completedAt accurately when attempt was completed offline', async () => {
    // Attempt started 10 minutes ago, but client completed the game in 14.5 seconds (14500 ms) before losing connection
    const tenMinutesAgo = new Date(Date.now() - 600000).toISOString();
    const completedAt = new Date(new Date(tenMinutesAgo).getTime() + 14500).toISOString();

    const challenge = crackTheCodeModule.createChallenge({ digits: 4 }, 'easy');

    const client = {
      query: vi
        .fn()
        // BEGIN transaction
        .mockResolvedValueOnce(result([]))
        // SELECT attempt FOR UPDATE
        .mockResolvedValueOnce(
          result([
            {
              id: 'asg-1',
              status: 'ASSIGNED',
              game_code: 'crack-the-code',
              game_name: 'Crack the Code',
              difficulty: 'easy',
              config: { timeLimitSeconds: 300 },
              public_challenge: challenge.publicData,
              secret_challenge: challenge.secretData,
              max_attempts: 3,
              cooldown_seconds: 15,
              round_sequence: 1,
              checkpoint_label: 'Lab 1',
              attempt_id: attemptId,
              attempt_status: 'in_progress',
              started_at: tenMinutesAgo,
              participant_id: participantSession.user_id,
              team_id: participantSession.team_id,
              result_metadata: null,
              submit_idempotency_key: null,
              duration_ms: null,
              checkpoint_count: 5,
            },
          ]),
        )
        // UPDATE game_attempts
        .mockResolvedValueOnce(result([]))
        // UPDATE game_assignments
        .mockResolvedValueOnce(result([]))
        // SELECT current_sequence FROM team_progress
        .mockResolvedValueOnce(result([{ current_sequence: 1 }]))
        // UPDATE team_progress sequence+1
        .mockResolvedValueOnce(result([]))
        // COMMIT
        .mockResolvedValueOnce(result([])),
      release: vi.fn(),
    };

    vi.mocked(db.pool.connect).mockResolvedValueOnce(client as never);
    vi.mocked(db.query).mockResolvedValueOnce(result([participantSession]));

    const response = await request(app)
      .post(`/api/v1/attempts/${attemptId}/submit`)
      .set('Authorization', 'Bearer player-token')
      .set('Idempotency-Key', 'idemp-offline-1')
      .send({
        result: {
          challengeToken: challenge.publicData.challengeToken,
          guesses: [challenge.secretData.code],
        },
        clientDurationMs: 14500,
        completedAt,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('passed');
    // Duration must be 14500ms (clientDurationMs) NOT 600,000ms (server elapsed time)
    expect(response.body.data.durationMs).toBe(14500);

    // Verify DB update parameters for game_attempts: status, ended_at, duration_ms
    const updateAttemptCall = client.query.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('UPDATE game_attempts'),
    );
    expect(updateAttemptCall).toBeDefined();
    // args: [attemptId, status, endedAt, durationMs, metadata, key]
    const args = updateAttemptCall![1] as unknown[];
    expect(args[0]).toBe(attemptId);
    expect(args[1]).toBe('passed');
    expect(args[3]).toBe(14500); // duration_ms
  });
});

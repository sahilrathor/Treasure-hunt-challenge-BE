import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import * as db from '../../src/db/pool.js';
import * as tx from '../../src/db/transaction.js';

vi.mock('../../src/db/pool.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn(), end: vi.fn() },
}));

vi.mock('../../src/db/transaction.js', () => ({
  withTransaction: vi.fn(),
}));

vi.mock('argon2', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hash-123'),
    verify: vi.fn().mockResolvedValue(true),
  },
}));

const result = (rows: unknown[]) =>
  ({ rows, command: 'SELECT', rowCount: rows.length, oid: 0, fields: [] }) as never;

const adminSession = {
  session_id: 'session-1',
  user_id: 'admin-1',
  role: 'ADMIN',
  display_name: 'Event Admin',
  username: 'admin@local.test',
  event_id: null,
  team_id: null,
  member_code: null,
};

describe('auth sessions and teammate login takeover', () => {
  const app = createApp({ logLevel: 'silent' });
  const participantId = '22222222-2222-4222-8222-222222222222';
  const teammateId = '33333333-3333-4333-8333-333333333333';
  const teamId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => vi.clearAllMocks());

  it('rejects login with 409 and activePlayer info when another teammate is logged in without force flag', async () => {
    // 1. query admin -> empty
    // 2. query participant -> found
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([
          {
            id: participantId,
            team_id: teamId,
            password_hash: 'hash-123',
          },
        ]),
      );

    const client = {
      query: vi
        .fn()
        // Lock team
        .mockResolvedValueOnce(result([{ id: teamId }]))
        // Active session check finds teammate
        .mockResolvedValueOnce(
          result([
            {
              participant_id: teammateId,
              display_name: 'Teammate Bob',
              member_code: 'TEAM-2',
              created_at: '2026-10-24T12:00:00Z',
            },
          ]),
        ),
    };

    vi.mocked(tx.withTransaction).mockImplementationOnce(async (callback) =>
      callback(client as never),
    );

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'TEAM-1', password: 'SecretPassword123!' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('TEAM_ALREADY_LOGGED_IN');
    expect(response.body.error.details.activePlayer).toEqual({
      participantId: teammateId,
      displayName: 'Teammate Bob',
      memberCode: 'TEAM-2',
      loggedInAt: '2026-10-24T12:00:00Z',
    });
  });

  it('revokes teammate active session and creates new session when force is true', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([
          {
            id: participantId,
            team_id: teamId,
            password_hash: 'hash-123',
          },
        ]),
      );

    const client = {
      query: vi
        .fn()
        // 1. Lock team
        .mockResolvedValueOnce(result([{ id: teamId }]))
        // 2. Active session check finds teammate
        .mockResolvedValueOnce(
          result([
            {
              participant_id: teammateId,
              display_name: 'Teammate Bob',
              member_code: 'TEAM-2',
              created_at: '2026-10-24T12:00:00Z',
            },
          ]),
        )
        // 3. Revoke teammate sessions
        .mockResolvedValueOnce(result([]))
        // 4. Revoke current user prior sessions
        .mockResolvedValueOnce(result([]))
        // 5. Insert new session
        .mockResolvedValueOnce(result([])),
    };

    vi.mocked(tx.withTransaction).mockImplementationOnce(async (callback) =>
      callback(client as never),
    );

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'TEAM-1', password: 'SecretPassword123!', force: true });

    expect(response.status).toBe(200);
    expect(response.body.data.authenticated).toBe(true);
    // Verify revoke was called for the team
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sessions SET revoked_at=now()'),
      [teamId],
    );
  });

  it('allows admin to force logout a participant session', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([adminSession]))
      .mockResolvedValueOnce(
        result([{ event_id: 'event-1', member_code: 'TEAM-1', display_name: 'Alice' }]),
      )
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]));

    const response = await request(app)
      .post(`/api/v1/admin/participants/${participantId}/logout`)
      .set('Authorization', 'Bearer admin-token')
      .send();

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ id: participantId, loggedOut: true });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sessions SET revoked_at=now() WHERE participant_id=$1'),
      [participantId],
    );
  });
});

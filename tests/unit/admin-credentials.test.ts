import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import * as db from '../../src/db/pool.js';

vi.mock('../../src/db/pool.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn(), end: vi.fn() },
}));

vi.mock('argon2', () => ({
  default: { hash: vi.fn().mockResolvedValue('new-password-hash') },
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

describe('admin credentials', () => {
  const app = createApp({ logLevel: 'silent' });

  beforeEach(() => vi.clearAllMocks());

  it('updates the username and password together', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([adminSession]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]));

    const response = await request(app)
      .patch('/api/v1/admin/account/credentials')
      .set('Authorization', 'Bearer admin-token')
      .send({ username: 'quest-admin', password: 'NewSecret123!' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { updated: true, username: 'quest-admin' } });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE admin_users SET email=$1,password_hash=$2'),
      ['quest-admin', 'new-password-hash', 'admin-1'],
    );
  });

  it('returns a clear conflict when the username is already used', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([adminSession]))
      .mockResolvedValueOnce(result([{ id: 'another-admin' }]));

    const response = await request(app)
      .patch('/api/v1/admin/account/credentials')
      .set('Authorization', 'Bearer admin-token')
      .send({ username: 'existing-admin', password: 'NewSecret123!' });

    expect(response.status).toBe(409);
    expect(response.body.error).toEqual({
      code: 'USERNAME_TAKEN',
      message: 'That admin username is already in use.',
    });
  });
});

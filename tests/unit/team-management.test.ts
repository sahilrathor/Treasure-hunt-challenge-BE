import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import * as db from '../../src/db/pool.js';

vi.mock('../../src/db/pool.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn(), end: vi.fn() },
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
  scan_token_hash: null,
};

describe('admin team management', () => {
  const app = createApp({ logLevel: 'silent' });
  const teamId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => vi.clearAllMocks());

  it('updates a team during draft setup', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([adminSession]))
      .mockResolvedValueOnce(
        result([{ event_id: 'event-1', code: 'TEAM-9', name: 'New Team Name' }]),
      )
      .mockResolvedValueOnce(result([]));

    const response = await request(app)
      .patch(`/api/v1/admin/teams/${teamId}`)
      .set('Authorization', 'Bearer admin-token')
      .send({ code: 'TEAM-9', name: 'New Team Name' });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      id: teamId,
      code: 'TEAM-9',
      name: 'New Team Name',
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("e.status='DRAFT'"), [
      teamId,
      'TEAM-9',
      'New Team Name',
    ]);
  });

  it('deletes a draft team and its participant sessions', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([{ event_id: 'event-1' }]))
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([])),
      release: vi.fn(),
    };
    vi.mocked(db.pool.connect).mockResolvedValueOnce(client as never);
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([adminSession]))
      .mockResolvedValueOnce(result([]));

    const response = await request(app)
      .delete(`/api/v1/admin/teams/${teamId}`)
      .set('Authorization', 'Bearer admin-token');

    expect(response.status).toBe(204);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM sessions'),
      [teamId],
    );
    expect(client.query).toHaveBeenCalledWith('DELETE FROM participants WHERE team_id=$1', [
      teamId,
    ]);
    expect(client.query).toHaveBeenCalledWith('DELETE FROM teams WHERE id=$1', [teamId]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

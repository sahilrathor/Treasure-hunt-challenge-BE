import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import * as db from '../../src/db/pool.js';

vi.mock('../../src/db/pool.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn(), end: vi.fn() },
}));

const result = (rows: unknown[], rowCount = rows.length) =>
  ({ rows, command: 'SELECT', rowCount, oid: 0, fields: [] }) as never;

const adminSession = {
  session_id: 'session-1',
  user_id: 'admin-1',
  role: 'ADMIN',
  display_name: 'Event Admin',
  username: 'admin',
  event_id: null,
  team_id: null,
  member_code: null,
};

describe('finished event lifecycle', () => {
  const app = createApp({ logLevel: 'silent' });
  const eventId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => vi.clearAllMocks());

  it('restarts a finished hunt while keeping its setup', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([{ status: 'FINISHED' }]))
        .mockResolvedValueOnce(result([], 7))
        .mockResolvedValueOnce(result([], 4))
        .mockResolvedValueOnce(result([], 3))
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
      .post(`/api/v1/admin/events/${eventId}/control`)
      .set('Authorization', 'Bearer admin-token')
      .send({ action: 'RESTART' });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      eventId,
      action: 'RESTART',
      reset: { attempts: 7, assignments: 4, teams: 3 },
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("status='NOT_STARTED'"),
      [eventId],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("status='DRAFT',starts_at=NULL,ends_at=NULL"),
      [eventId],
    );
  });

  it('creates a blank draft while preserving the finished hunt', async () => {
    const newEvent = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'College Fest Hunt - New Hunt',
      slug: 'college-fest-hunt-new-1234',
    };
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(
          result([
            {
              name: 'College Fest Hunt',
              slug: 'college-fest-hunt',
              settings: { checkpointCount: 8 },
              status: 'FINISHED',
            },
          ]),
        )
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([newEvent]))
        .mockResolvedValueOnce(result([])),
      release: vi.fn(),
    };
    vi.mocked(db.pool.connect).mockResolvedValueOnce(client as never);
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([adminSession]))
      .mockResolvedValueOnce(result([]));

    const response = await request(app)
      .post(`/api/v1/admin/events/${eventId}/new-hunt`)
      .set('Authorization', 'Bearer admin-token');

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: newEvent });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO events(name,slug,settings)'),
      expect.arrayContaining(['College Fest Hunt - New Hunt', { checkpointCount: 8 }]),
    );
  });
});

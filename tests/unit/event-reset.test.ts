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

describe('admin event reset', () => {
  const app = createApp({ logLevel: 'silent' });
  const eventId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => vi.clearAllMocks());

  it('rejects reset without correct confirmation phrase', async () => {
    vi.mocked(db.query).mockResolvedValueOnce(result([adminSession]));

    const response = await request(app)
      .post(`/api/v1/admin/events/${eventId}/reset`)
      .set('Authorization', 'Bearer admin-token')
      .send({ target: 'all', confirmationText: 'WRONG_TEXT' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_CONFIRMATION');
  });

  it('resets all hunt data with RESET ALL phrase', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(result([])) // BEGIN
        .mockResolvedValueOnce(result([{ id: eventId, status: 'RUNNING' }])) // select event
        .mockResolvedValue(result([])), // all deletes and updates
      release: vi.fn(),
    };
    vi.mocked(db.pool.connect).mockResolvedValueOnce(client as never);
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([adminSession]))
      .mockResolvedValueOnce(result([])); // audit

    const response = await request(app)
      .post(`/api/v1/admin/events/${eventId}/reset`)
      .set('Authorization', 'Bearer admin-token')
      .send({ target: 'all', confirmationText: 'RESET ALL' });

    expect(response.status).toBe(200);
    expect(response.body.data.target).toBe('all');
    expect(response.body.data.deleted).toBe(true);
  });

  it('resets locations with RESET LOCATIONS phrase', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(result([])) // BEGIN
        .mockResolvedValueOnce(result([{ id: eventId, status: 'DRAFT' }])) // select event
        .mockResolvedValue(result([])), // deletes
      release: vi.fn(),
    };
    vi.mocked(db.pool.connect).mockResolvedValueOnce(client as never);
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([adminSession]))
      .mockResolvedValueOnce(result([])); // audit

    const response = await request(app)
      .post(`/api/v1/admin/events/${eventId}/reset`)
      .set('Authorization', 'Bearer admin-token')
      .send({ target: 'locations', confirmationText: 'RESET LOCATIONS' });

    expect(response.status).toBe(200);
    expect(response.body.data.target).toBe('locations');
    expect(response.body.data.deleted).toBe(true);
  });
});

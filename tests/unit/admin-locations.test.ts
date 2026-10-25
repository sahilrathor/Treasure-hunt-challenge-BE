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
  session_id: 'session-admin',
  user_id: 'admin-1',
  role: 'ADMIN',
  display_name: 'Event Admin',
  event_id: null,
  team_id: null,
  member_code: null,
};

describe('admin locations and routes', () => {
  const app = createApp({ logLevel: 'silent' });

  beforeEach(() => vi.clearAllMocks());

  it('updates checkpoint label, clue, note, and showNoteToPlayer without requiring teamId', async () => {
    const checkpointId = '11111111-1111-4111-8111-111111111111';
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([adminSession]))
      .mockResolvedValueOnce(
        result([
          {
            event_id: 'event-1',
            code: 'LOC-1',
            label: 'Main Gate',
            clue: 'Look near the gate',
            note: 'Do not cross the yellow line',
            show_note_to_player: true,
            qr_token: 'valid-qr-token',
          },
        ]),
      )
      .mockResolvedValueOnce(result([])); // audit log

    const response = await request(app)
      .patch(`/api/v1/admin/checkpoints/${checkpointId}`)
      .set('Authorization', 'Bearer admin-token')
      .send({
        label: 'Main Gate',
        clue: 'Look near the gate',
        note: 'Do not cross the yellow line',
        showNoteToPlayer: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: checkpointId,
      code: 'LOC-1',
      label: 'Main Gate',
      clue: 'Look near the gate',
      note: 'Do not cross the yellow line',
      showNoteToPlayer: true,
      qrToken: 'valid-qr-token',
    });
  });

  it('saves team round location mappings with repetition support', async () => {
    const eventId = '22222222-2222-4222-8222-222222222222';
    const teamId = '33333333-3333-4333-8333-333333333333';
    const loc1 = '44444444-4444-4444-8444-444444444444';
    const loc2 = '55555555-5555-4555-8555-555555555555';

    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(result([])) // BEGIN
        .mockResolvedValueOnce(result([{ id: eventId, status: 'DRAFT' }]))
        .mockResolvedValue(result([])),
      release: vi.fn(),
    };
    vi.mocked(db.pool.connect).mockResolvedValueOnce(client as never);
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([adminSession]))
      .mockResolvedValueOnce(result([])); // audit log

    const response = await request(app)
      .post(`/api/v1/admin/events/${eventId}/team-round-locations`)
      .set('Authorization', 'Bearer admin-token')
      .send({
        mappings: [
          { teamId, roundSequence: 1, checkpointId: loc1 },
          { teamId, roundSequence: 2, checkpointId: loc2 },
          { teamId, roundSequence: 3, checkpointId: loc1 }, // repetition!
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ updated: true, count: 3 });
  });

  it('configures rounds and locations independently via structure endpoint', async () => {
    const eventId = '22222222-2222-4222-8222-222222222222';
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(result([])) // BEGIN
        .mockResolvedValueOnce(result([{ status: 'DRAFT', round_count: 3, location_count: 4 }]))
        .mockResolvedValue(result([])),
      release: vi.fn(),
    };
    vi.mocked(db.pool.connect).mockResolvedValueOnce(client as never);
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([adminSession]))
      .mockResolvedValueOnce(result([])); // audit

    const response = await request(app)
      .patch(`/api/v1/admin/events/${eventId}/structure`)
      .set('Authorization', 'Bearer admin-token')
      .send({
        roundCount: 5,
        locationCount: 7,
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      roundCount: 5,
      locationCount: 7,
    });
  });
});

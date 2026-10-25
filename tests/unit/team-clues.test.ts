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

const participantSession = {
  session_id: 'session-1',
  user_id: 'participant-1',
  role: 'PARTICIPANT',
  display_name: 'Player One',
  event_id: 'event-1',
  team_id: 'team-1',
  member_code: 'PLAYER-1',
};

const adminSession = {
  session_id: 'session-2',
  user_id: 'admin-1',
  role: 'ADMIN',
  display_name: 'Event Admin',
  event_id: null,
  team_id: null,
  member_code: null,
};

describe('team-specific clues', () => {
  const app = createApp({ logLevel: 'silent' });

  beforeEach(() => vi.clearAllMocks());

  it('returns the current round clue resolved for the participant team', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([participantSession]))
      .mockResolvedValueOnce(
        result([
          {
            status: 'IN_PROGRESS',
            current_sequence: 2,
            sequence: 2,
            clue: 'Team 1 clue',
            note: null,
            checkpoint_label: null,
          },
        ]),
      );

    const response = await request(app)
      .get('/api/v1/teams/me/clue')
      .set('Authorization', 'Bearer participant-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: { status: 'IN_PROGRESS', round: 2, clue: 'Team 1 clue', note: null, locationLabel: null },
    });
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining('COALESCE(NULLIF(c.clue, \'\'), trc.clue, r.clue, \'\')'),
      ['team-1', 'event-1'],
    );
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining('trc.team_id = tp.team_id'), [
      'team-1',
      'event-1',
    ]);
  });

  it('saves every clue for the selected team without changing round defaults', async () => {
    const eventId = '11111111-1111-4111-8111-111111111111';
    const teamId = '22222222-2222-4222-8222-222222222222';
    const roundId = '33333333-3333-4333-8333-333333333333';
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([{ id: eventId, status: 'DRAFT' }]))
        .mockResolvedValueOnce(result([{ id: teamId }]))
        .mockResolvedValueOnce(result([{ round_id: roundId }]))
        .mockResolvedValueOnce(result([])),
      release: vi.fn(),
    };
    vi.mocked(db.pool.connect).mockResolvedValueOnce(client as never);
    vi.mocked(db.query)
      .mockResolvedValueOnce(result([adminSession]))
      .mockResolvedValueOnce(result([]));

    const response = await request(app)
      .post(`/api/v1/admin/events/${eventId}/clues`)
      .set('Authorization', 'Bearer admin-token')
      .send({ teamId, clues: [{ roundId, clue: 'Only Team 2 sees this' }] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { updated: true } });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO team_round_clues'),
      [teamId, roundId, 'Only Team 2 sees this', eventId],
    );
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE rounds SET clue'),
      expect.anything(),
    );
  });
});

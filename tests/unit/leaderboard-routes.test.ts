import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createApp } from '../../src/app.js';
import * as db from '../../src/db/pool.js';

vi.mock('../../src/db/pool.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn(), end: vi.fn() },
}));

describe('Leaderboard routes', () => {
  const app = createApp({ logLevel: 'silent' });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockAdminSession = () => ({
    session_id: 's-1',
    user_id: 'a-1',
    role: 'ADMIN',
    display_name: 'Admin Organiser',
    event_id: null,
    team_id: null,
    member_code: null,
  });

  const mockParticipantSession = () => ({
    session_id: 's-2',
    user_id: 'p-1',
    role: 'PARTICIPANT',
    display_name: 'Student One',
    event_id: 'e-1',
    team_id: 't-1',
    member_code: 'MEMBER-1',
  });

  it('rejects unauthenticated requests to leaderboard', async () => {
    const response = await request(app).get('/api/v1/leaderboard');
    expect(response.status).toBe(401);
  });

  it('rejects participant requests to leaderboard (admin only)', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [mockParticipantSession()],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const response = await request(app)
      .get('/api/v1/leaderboard')
      .set('Authorization', 'Bearer participant-token');

    expect(response.status).toBe(403);
  });

  it('returns empty lists for admin if no event is active when eventId is omitted', async () => {
    // 1. authenticate session
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [mockAdminSession()],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    // 2. active event query returns empty
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      command: 'SELECT',
      rowCount: 0,
      oid: 0,
      fields: [],
    });

    const response = await request(app)
      .get('/api/v1/leaderboard')
      .set('Authorization', 'Bearer admin-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        event: null,
        completed: [],
        incomplete: [],
      },
    });
  });

  it('fetches leaderboard for the active event automatically for admin', async () => {
    // 1. authenticate session
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [mockAdminSession()],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    // 2. active event query
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          name: 'Campus Hunt 2026',
          slug: 'campus-2026',
          status: 'RUNNING',
        },
      ],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    // 3. leaderboardSql query
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          id: 't-1',
          code: 'TEAM-01',
          name: 'Alpha',
          status: 'COMPLETED',
          current_sequence: 9,
          started_at: '2026-10-18T10:00:00Z',
          completed_at: '2026-10-18T10:30:00Z',
          failed_attempts: 1,
          adjusted_time_ms: 1800000,
        },
        {
          id: 't-2',
          code: 'TEAM-02',
          name: 'Beta',
          status: 'IN_PROGRESS',
          current_sequence: 4,
          started_at: '2026-10-18T10:00:00Z',
          completed_at: null,
          failed_attempts: 0,
          adjusted_time_ms: null,
        },
      ],
      command: 'SELECT',
      rowCount: 2,
      oid: 0,
      fields: [],
    });

    const response = await request(app)
      .get('/api/v1/leaderboard')
      .set('Authorization', 'Bearer admin-token');

    expect(response.status).toBe(200);
    expect(response.body.data.event).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Campus Hunt 2026',
      slug: 'campus-2026',
      status: 'RUNNING',
    });
    expect(response.body.data.completed).toHaveLength(1);
    expect(response.body.data.completed[0].code).toBe('TEAM-01');
    expect(response.body.data.incomplete).toHaveLength(1);
    expect(response.body.data.incomplete[0].code).toBe('TEAM-02');
  });

  it('fetches how rounds were played for a team on GET /admin/teams/:teamId/rounds', async () => {
    // 1. authenticate session
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [mockAdminSession()],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const teamId = 'a0000000-0000-4000-8000-000000000001';

    // 2. team query
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          id: teamId,
          code: 'TEAM-01',
          name: 'Cyber Crusaders',
          event_id: '11111111-1111-4111-8111-111111111111',
          status: 'IN_PROGRESS',
          current_sequence: 3,
          started_at: '2026-10-18T10:00:00Z',
          completed_at: null,
        },
      ],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    // 3. rounds query
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          round: 1,
          checkpoint_label: 'Library',
          game_name: 'Snake',
          game_code: 'snake',
          assignment_id: 'a-1',
          assignment_status: 'PASSED',
          passed_at: '2026-10-18T10:05:00Z',
          attempts: [
            {
              id: 'att-1',
              attempt_number: 1,
              status: 'passed',
              started_at: '2026-10-18T10:04:45Z',
              ended_at: '2026-10-18T10:05:00Z',
              duration_ms: 15000,
              member_code: 'MEMBER-1',
              display_name: 'Alice',
            },
          ],
        },
      ],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const response = await request(app)
      .get(`/api/v1/admin/teams/${teamId}/rounds`)
      .set('Authorization', 'Bearer admin-token');

    expect(response.status).toBe(200);
    expect(response.body.data.team.code).toBe('TEAM-01');
    expect(response.body.data.rounds).toHaveLength(1);
    expect(response.body.data.rounds[0].game_name).toBe('Snake');
    expect(response.body.data.rounds[0].attempts[0].display_name).toBe('Alice');
    expect(response.body.data.rounds[0].attempts[0].status).toBe('passed');
  });
});

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

const participantSession = {
  session_id: 'session-player-1',
  user_id: '11111111-1111-4111-8111-111111111111',
  role: 'PARTICIPANT',
  display_name: 'Player One',
  member_code: 'PLAYER-1',
  event_id: '22222222-2222-4222-8222-222222222222',
  team_id: '33333333-3333-4333-8333-333333333333',
  scan_token_hash: null,
};

describe('auto-start team progress during running event', () => {
  const app = createApp({ logLevel: 'silent' });

  beforeEach(() => vi.clearAllMocks());

  it('auto-starts team progress when scanning during a RUNNING event instead of throwing HUNT_NOT_ACTIVE', async () => {
    const client = {
      query: vi
        .fn()
        // BEGIN
        .mockResolvedValueOnce(result([]))
        // SELECT progress FOR UPDATE (progress_status is NOT_STARTED, event is RUNNING)
        .mockResolvedValueOnce(
          result([{ current_sequence: 1, progress_status: 'NOT_STARTED', event_status: 'RUNNING' }]),
        )
        // UPDATE team_progress SET status='IN_PROGRESS'
        .mockResolvedValueOnce(result([]))
        // Identify scanned checkpoint
        .mockResolvedValueOnce(
          result([{ id: 'cp-1', label: 'Library', code: 'cp-01', active: true }]),
        )
        // Identify current round
        .mockResolvedValueOnce(
          result([{ id: 'round-1', sequence: 1, difficulty: 'easy', game_id: 'game-1', checkpoint_id: 'cp-1' }]),
        )
        // Check assigned location
        .mockResolvedValueOnce(result([{ checkpoint_id: 'cp-1' }]))
        // Existing assignment check
        .mockResolvedValueOnce(
          result([
            {
              id: 'asg-1',
              status: 'ASSIGNED',
              game_enabled: true,
              game_code: 'crack-the-code',
              game_name: 'Crack the Code',
              difficulty: 'easy',
              config: {},
              max_attempts: 3,
              cooldown_seconds: 10,
              current_sequence: 1,
              round_sequence: 1,
              checkpoint_label: 'Library',
              clue: '',
              checkpoint_clue: '',
              checkpoint_note: '',
              show_note_to_player: false,
              note: '',
              game_id: 'game-1',
            },
          ]),
        )
        // Active attempt query
        .mockResolvedValueOnce(result([]))
        // Attempt count query
        .mockResolvedValueOnce(result([{ count: 0 }]))
        // COMMIT
        .mockResolvedValueOnce(result([])),
      release: vi.fn(),
    };
    vi.mocked(db.pool.connect).mockResolvedValueOnce(client as never);
    vi.mocked(db.query).mockResolvedValueOnce(result([participantSession]));

    const response = await request(app)
      .post('/api/v1/checkpoints/scan')
      .set('Authorization', 'Bearer player-token')
      .send({ token: '12345678901234567890' });

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe('asg-1');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE team_progress SET status='IN_PROGRESS'"),
      expect.any(Array),
    );
  });

  it('auto-starts team progress when viewing clue during a RUNNING event', async () => {
    vi.mocked(db.query)
      // Session lookup
      .mockResolvedValueOnce(result([participantSession]))
      // SELECT clue query (event_status RUNNING, tp.status NOT_STARTED)
      .mockResolvedValueOnce(
        result([
          {
            status: 'NOT_STARTED',
            event_status: 'RUNNING',
            current_sequence: 1,
            clue: 'Look behind the bookshelf',
            note: null,
            checkpoint_label: 'Library',
          },
        ]),
      )
      // UPDATE team_progress SET status='IN_PROGRESS'
      .mockResolvedValueOnce(result([]));

    const response = await request(app)
      .get('/api/v1/teams/me/clue')
      .set('Authorization', 'Bearer player-token');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      status: 'IN_PROGRESS',
      round: 1,
      clue: 'Look behind the bookshelf',
      note: null,
      locationLabel: 'Library',
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE team_progress SET status='IN_PROGRESS'"),
      expect.any(Array),
    );
  });
});

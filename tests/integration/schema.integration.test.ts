import type { PoolClient } from 'pg';

import { pool } from '../../src/db/pool.js';

describe.skipIf(process.env.RUN_DB_TESTS !== 'true')('PostgreSQL schema', () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterAll(async () => {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  });

  it('contains the core transactional tables and seeded games', async () => {
    const tables = await client.query<{ table_name: string }>(
      `
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name = ANY($1::text[])
    `,
      [
        [
          'events',
          'teams',
          'participants',
          'game_assignments',
          'game_attempts',
          'team_progress',
          'team_round_clues',
        ],
      ],
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      'events',
      'game_assignments',
      'game_attempts',
      'participants',
      'team_progress',
      'team_round_clues',
      'teams',
    ]);
    expect(
      (await client.query(`SELECT count(*)::int count FROM games WHERE enabled`)).rows[0]?.count,
    ).toBe(8);
    expect(
      (await client.query(`SELECT count(*)::int count FROM game_levels WHERE enabled`)).rows[0]
        ?.count,
    ).toBe(24);
  });

  it('enforces no-repeat assignments, one active attempt, and team membership', async () => {
    const event = (
      await client.query<{ id: string }>(
        `INSERT INTO events(name,slug) VALUES ('Test Event',$1) RETURNING id`,
        [`test-${crypto.randomUUID()}`],
      )
    ).rows[0]!;
    const teamOne = (
      await client.query<{ id: string }>(
        `INSERT INTO teams(event_id,code,name) VALUES ($1,'A','Alpha') RETURNING id`,
        [event.id],
      )
    ).rows[0]!;
    const teamTwo = (
      await client.query<{ id: string }>(
        `INSERT INTO teams(event_id,code,name) VALUES ($1,'B','Beta') RETURNING id`,
        [event.id],
      )
    ).rows[0]!;
    const participantOne = (
      await client.query<{ id: string }>(
        `INSERT INTO participants(event_id,team_id,member_code,display_name,password_hash) VALUES ($1,$2,'A1','A One','hash') RETURNING id`,
        [event.id, teamOne.id],
      )
    ).rows[0]!;
    const participantTwo = (
      await client.query<{ id: string }>(
        `INSERT INTO participants(event_id,team_id,member_code,display_name,password_hash) VALUES ($1,$2,'A2','A Two','hash') RETURNING id`,
        [event.id, teamOne.id],
      )
    ).rows[0]!;
    const outsider = (
      await client.query<{ id: string }>(
        `INSERT INTO participants(event_id,team_id,member_code,display_name,password_hash) VALUES ($1,$2,'B1','B One','hash') RETURNING id`,
        [event.id, teamTwo.id],
      )
    ).rows[0]!;
    const checkpoints = await client.query<{ id: string }>(
      `INSERT INTO checkpoints(event_id,code,label,qr_token_hash) VALUES ($1,'C1','One',$2),($1,'C2','Two',$3) RETURNING id`,
      [event.id, 'a'.repeat(64), 'b'.repeat(64)],
    );
    const rounds = await Promise.all(
      checkpoints.rows.map((checkpoint, index) =>
        client.query<{ id: string }>(
          `INSERT INTO rounds(event_id,checkpoint_id,sequence,clue,difficulty) VALUES ($1,$2,$3,'clue','easy') RETURNING id`,
          [event.id, checkpoint.id, index + 1],
        ),
      ),
    );
    const game = (
      await client.query<{ game_id: string; level_id: string }>(
        `SELECT g.id game_id,l.id level_id FROM games g JOIN game_levels l ON l.game_id=g.id WHERE g.code='snake' AND l.difficulty='easy'`,
      )
    ).rows[0]!;
    const assignment = (
      await client.query<{ id: string }>(
        `INSERT INTO game_assignments(team_id,round_id,game_id,game_level_id,public_challenge,secret_challenge) VALUES ($1,$2,$3,$4,'{}','{}') RETURNING id`,
        [teamOne.id, rounds[0]!.rows[0]!.id, game.game_id, game.level_id],
      )
    ).rows[0]!;

    await client.query('SAVEPOINT duplicate_game');
    await expect(
      client.query(
        `INSERT INTO game_assignments(team_id,round_id,game_id,game_level_id,public_challenge,secret_challenge) VALUES ($1,$2,$3,$4,'{}','{}')`,
        [teamOne.id, rounds[1]!.rows[0]!.id, game.game_id, game.level_id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await client.query('ROLLBACK TO SAVEPOINT duplicate_game');

    await client.query(
      `INSERT INTO game_attempts(assignment_id,team_id,participant_id,attempt_number,start_idempotency_key) VALUES ($1,$2,$3,1,'first-key')`,
      [assignment.id, teamOne.id, participantOne.id],
    );
    await client.query('SAVEPOINT concurrent_attempt');
    await expect(
      client.query(
        `INSERT INTO game_attempts(assignment_id,team_id,participant_id,attempt_number,start_idempotency_key) VALUES ($1,$2,$3,1,'second-key')`,
        [assignment.id, teamOne.id, participantTwo.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await client.query('ROLLBACK TO SAVEPOINT concurrent_attempt');
    await client.query(
      `UPDATE game_attempts SET status='cancelled',ended_at=now(),duration_ms=1 WHERE assignment_id=$1`,
      [assignment.id],
    );

    await client.query('SAVEPOINT wrong_team');
    await expect(
      client.query(
        `INSERT INTO game_attempts(assignment_id,team_id,participant_id,attempt_number,start_idempotency_key) VALUES ($1,$2,$3,2,'outsider-key')`,
        [assignment.id, teamOne.id, outsider.id],
      ),
    ).rejects.toThrow(/does not belong to team/);
    await client.query('ROLLBACK TO SAVEPOINT wrong_team');
  });
});

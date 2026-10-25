import argon2 from 'argon2';
import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { query } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { authenticate, requireAdmin, requireRole } from '../../middleware/authenticate.js';
import { createToken, hashToken } from '../../utils/crypto.js';
import { HttpError } from '../../utils/http-error.js';
import { asyncRoute } from '../../utils/route.js';
import { getGameModule } from '../games/game-registry.js';

const uuid = z.string().uuid();
const eventSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/)
    .max(80),
});
const teamSchema = z.object({
  eventId: uuid,
  code: z.string().trim().min(2).max(30),
  name: z.string().trim().min(2).max(100),
});
const participantSchema = z.object({
  memberCode: z.string().trim().min(2).max(30),
  displayName: z.string().trim().min(2).max(100),
  password: z.string().min(10).max(200),
});
const checkpointSchema = z.object({
  eventId: uuid,
  code: z.string().trim().min(2).max(40),
  label: z.string().trim().min(2).max(120),
});
const roundSchema = z.object({
  eventId: uuid,
  checkpointId: uuid,
  sequence: z.number().int().min(1).max(8),
  clue: z.string().trim().min(2).max(1000),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  gameId: uuid.nullable().optional(),
});

async function audit(
  adminId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  eventId: string | null,
  details: unknown = {},
) {
  await query(
    `INSERT INTO admin_audit_logs(admin_id,event_id,action,entity_type,entity_id,details) VALUES ($1,$2,$3,$4,$5,$6)`,
    [adminId, eventId, action, entityType, entityId, details],
  );
}

export const adminRouter = Router();
adminRouter.use('/admin', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'));

adminRouter.get(
  '/admin/simple',
  asyncRoute(async (request, response) => {
    requireAdmin(request);
    const event = await query<{
      id: string;
      name: string;
      slug: string;
      status: string;
      checkpoint_count: number;
      round_count: number;
      location_count: number;
    }>(
      `SELECT id, name, slug, status,
              COALESCE((settings->>'roundCount')::int, (settings->>'checkpointCount')::int, (SELECT count(*)::int FROM rounds WHERE event_id=events.id), 5) AS round_count,
              COALESCE((settings->>'locationCount')::int, (SELECT count(*)::int FROM checkpoints WHERE event_id=events.id AND active), (settings->>'checkpointCount')::int, 5) AS location_count,
              COALESCE((settings->>'checkpointCount')::int, 8) AS checkpoint_count
       FROM events ORDER BY (status='DRAFT') DESC, created_at DESC LIMIT 1`,
    );
    const current = event.rows[0];
    if (!current) {
      response.json({ data: { event: null, teams: [], checkpoints: [], rounds: [] } });
      return;
    }
    const [teams, checkpoints, rounds, teamRoundLocations, activeSessions] = await Promise.all([
      query(
        `SELECT t.id, t.code, t.name, tp.status, tp.current_sequence,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', p.id,
               'memberCode', p.member_code,
               'displayName', p.display_name,
               'isLoggedIn', (s.id IS NOT NULL),
               'loggedInAt', s.created_at,
               'sessionId', s.id
             )
             ORDER BY p.member_code
           ) FILTER (WHERE p.id IS NOT NULL),
           '[]'::jsonb
         ) participants
         FROM teams t
         JOIN team_progress tp ON tp.team_id=t.id
         LEFT JOIN participants p ON p.team_id=t.id AND p.active
         LEFT JOIN (
           SELECT DISTINCT ON (participant_id) id, participant_id, created_at
           FROM sessions
           WHERE revoked_at IS NULL AND expires_at > now()
           ORDER BY participant_id, created_at DESC
         ) s ON s.participant_id = p.id
         WHERE t.event_id=$1 AND t.active
         GROUP BY t.id, tp.status, tp.current_sequence
         ORDER BY t.code`,
        [current.id],
      ),
      query<{
        id: string;
        code: string;
        label: string;
        clue: string;
        note: string;
        show_note_to_player: boolean;
        qr_token: string | null;
        active: boolean;
      }>(
        `SELECT c.id, c.code, c.label, c.clue, c.note, c.show_note_to_player, c.qr_token, c.active
         FROM checkpoints c
         WHERE c.event_id=$1 AND c.active
         ORDER BY c.code, c.created_at`,
        [current.id],
      ),
      query<{
        id: string;
        sequence: number;
        difficulty: 'easy' | 'medium' | 'hard';
        clue: string;
        checkpoint_id: string | null;
        game_id: string | null;
        game_name: string | null;
        game_code: string | null;
      }>(
        `SELECT r.id, r.sequence, r.difficulty, r.clue, r.checkpoint_id,
                r.game_id, g.name AS game_name, g.code AS game_code
         FROM rounds r
         LEFT JOIN games g ON g.id = r.game_id
         WHERE r.event_id=$1
         ORDER BY r.sequence`,
        [current.id],
      ),
      query<{
        team_id: string;
        round_sequence: number;
        checkpoint_id: string;
      }>(
        `SELECT trl.team_id, trl.round_sequence, trl.checkpoint_id
         FROM team_round_locations trl
         JOIN teams t ON t.id = trl.team_id
         WHERE t.event_id = $1`,
        [current.id],
      ),
      query<{
        session_id: string;
        logged_in_at: string;
        participant_id: string;
        display_name: string;
        member_code: string;
        team_id: string;
        team_name: string;
        team_code: string;
      }>(
        `SELECT s.id AS session_id, s.created_at AS logged_in_at,
                p.id AS participant_id, p.display_name, p.member_code,
                t.id AS team_id, t.name AS team_name, t.code AS team_code
         FROM sessions s
         JOIN participants p ON p.id = s.participant_id AND p.active
         JOIN teams t ON t.id = p.team_id AND t.active
         WHERE t.event_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
         ORDER BY s.created_at DESC`,
        [current.id],
      ),
    ]);

    // Ensure all active checkpoints have a static QR token
    for (const cp of checkpoints.rows) {
      if (!cp.qr_token) {
        const token = createToken(24);
        await query(
          `UPDATE checkpoints SET qr_token=$2, qr_token_hash=$3 WHERE id=$1`,
          [cp.id, token, hashToken(token)],
        );
        cp.qr_token = token;
      }
    }

    const teamLocationsMap: Record<string, Record<number, string>> = {};
    for (const trl of teamRoundLocations.rows) {
      const teamMap = teamLocationsMap[trl.team_id] ?? (teamLocationsMap[trl.team_id] = {});
      teamMap[trl.round_sequence] = trl.checkpoint_id;
    }

    const formattedTeams = teams.rows.map((t: any) => ({
      ...t,
      roundLocations: teamLocationsMap[t.id] ?? {},
    }));

    const formattedCheckpoints = checkpoints.rows.map((c, index) => {
      const matchingRound = rounds.rows.find((r) => r.checkpoint_id === c.id);
      return {
        id: c.id,
        code: c.code,
        label: c.label,
        clue: c.clue,
        note: c.note,
        show_note_to_player: c.show_note_to_player,
        qr_token: c.qr_token,
        scanUrl: c.qr_token
          ? `${env.FRONTEND_ORIGIN}/scan?token=${encodeURIComponent(c.qr_token)}`
          : '',
        active: c.active,
        sequence: matchingRound?.sequence ?? index + 1,
        round_id: matchingRound?.id,
        difficulty: matchingRound?.difficulty ?? 'easy',
        game_id: matchingRound?.game_id ?? null,
        game_name: matchingRound?.game_name ?? null,
        game_code: matchingRound?.game_code ?? null,
      };
    });

    response.json({
      data: {
        event: current,
        teams: formattedTeams,
        checkpoints: formattedCheckpoints,
        rounds: rounds.rows,
        teamRoundLocations: teamRoundLocations.rows,
        activeSessions: activeSessions.rows.map((row) => ({
          sessionId: row.session_id,
          loggedInAt: row.logged_in_at,
          participantId: row.participant_id,
          displayName: row.display_name,
          memberCode: row.member_code,
          teamId: row.team_id,
          teamName: row.team_name,
          teamCode: row.team_code,
        })),
      },
    });
  }),
);

adminRouter.post(
  '/admin/simple/setup',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const input = z
      .object({
        roundCount: z.number().int().min(1).max(16).optional(),
        locationCount: z.number().int().min(1).max(20).optional(),
        checkpointCount: z.number().int().min(1).max(20).optional(),
      })
      .parse(request.body);

    const roundCount = input.roundCount ?? input.checkpointCount ?? 5;
    const locationCount = input.locationCount ?? input.checkpointCount ?? 5;

    const result = await withTransaction(async (client) => {
      const draft = await client.query<{ id: string; slug: string }>(
        `SELECT id,slug FROM events WHERE status='DRAFT' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      );
      let current = draft.rows[0];
      if (!current) {
        const slug = `college-fest-hunt-${Date.now()}`;
        const created = await client.query<{ id: string; slug: string }>(
          `INSERT INTO events(name,slug,settings)
           VALUES ('College Fest Hunt',$1,jsonb_build_object('roundCount',$2::int,'locationCount',$3::int,'checkpointCount',$2::int))
           RETURNING id,slug`,
          [slug, roundCount, locationCount],
        );
        current = created.rows[0]!;
      } else {
        await client.query(
          `UPDATE events SET settings=settings || jsonb_build_object('roundCount',$2::int,'locationCount',$3::int,'checkpointCount',$2::int) WHERE id=$1`,
          [current.id, roundCount, locationCount],
        );
        await client.query(
          `DELETE FROM team_round_locations WHERE team_id IN (SELECT id FROM teams WHERE event_id=$1)`,
          [current.id],
        );
        await client.query(`DELETE FROM rounds WHERE event_id=$1`, [current.id]);
        await client.query(`DELETE FROM checkpoints WHERE event_id=$1`, [current.id]);
      }

      // 1. Create physical venue locations (checkpoints)
      const checkpoints: Array<{ id: string; label: string; code: string; sequence: number }> = [];
      for (let locIdx = 1; locIdx <= locationCount; locIdx += 1) {
        const token = createToken(24);
        const checkpoint = await client.query<{ id: string; label: string; code: string }>(
          `INSERT INTO checkpoints(event_id,code,label,clue,note,show_note_to_player,qr_token,qr_token_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,label,code`,
          [
            current.id,
            `LOC-${locIdx}`,
            `Location ${locIdx}`,
            `Proceed to Location ${locIdx}.`,
            '',
            false,
            token,
            hashToken(token),
          ],
        );
        checkpoints.push({
          id: checkpoint.rows[0]!.id,
          label: checkpoint.rows[0]!.label,
          code: checkpoint.rows[0]!.code,
          sequence: locIdx,
        });
      }

      // 2. Create competition rounds (independent of location count)
      const rounds: Array<{ id: string; sequence: number; difficulty: string }> = [];
      for (let seq = 1; seq <= roundCount; seq += 1) {
        const difficulty =
          seq <= Math.ceil(roundCount / 3)
            ? 'easy'
            : seq <= Math.ceil((roundCount * 2) / 3)
              ? 'medium'
              : 'hard';
        const defaultCp = checkpoints[(seq - 1) % checkpoints.length]!;
        const round = await client.query<{ id: string; sequence: number }>(
          `INSERT INTO rounds(event_id,checkpoint_id,sequence,clue,difficulty)
           VALUES ($1,$2,$3,$4,$5) RETURNING id,sequence`,
          [
            current.id,
            defaultCp.id,
            seq,
            `Proceed to your assigned location for Round ${seq}.`,
            difficulty,
          ],
        );
        rounds.push({
          id: round.rows[0]!.id,
          sequence: seq,
          difficulty,
        });
      }

      // 3. Populate default team round locations if teams exist
      const existingTeams = await client.query<{ id: string }>(
        `SELECT id FROM teams WHERE event_id=$1 AND active`,
        [current.id],
      );
      for (const t of existingTeams.rows) {
        for (let seq = 1; seq <= roundCount; seq += 1) {
          const defaultCp = checkpoints[(seq - 1) % checkpoints.length]!;
          await client.query(
            `INSERT INTO team_round_locations(team_id, round_sequence, checkpoint_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (team_id, round_sequence) DO UPDATE SET checkpoint_id = EXCLUDED.checkpoint_id`,
            [t.id, seq, defaultCp.id],
          );
        }
      }

      return {
        eventId: current.id,
        eventSlug: current.slug,
        roundCount,
        locationCount,
        checkpoints,
        rounds,
      };
    });

    await audit(admin.userId, 'SIMPLE_SETUP', 'event', result.eventId, result.eventId, {
      roundCount,
      locationCount,
    });
    response.status(201).json({ data: result });
  }),
);

adminRouter.post(
  '/admin/simple/teams',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const input = z
      .object({
        eventId: uuid,
        code: z.string().trim().min(2).max(30),
        name: z.string().trim().min(2).max(100),
        members: z
          .array(
            z.object({
              memberCode: z.string().trim().min(2).max(30),
              displayName: z.string().trim().min(2).max(100),
            }),
          )
          .min(3)
          .max(5),
      })
      .parse(request.body);
    const credentials = await Promise.all(
      input.members.map(async (member) => {
        const password = `Hunt-${randomInt(100000, 1000000)}!`;
        return {
          ...member,
          password,
          passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        };
      }),
    );
    const teamId = await withTransaction(async (client) => {
      const team = await client.query<{ id: string }>(
        `INSERT INTO teams(event_id,code,name)
         SELECT $1,$2,$3 FROM events WHERE id=$1 AND status='DRAFT' RETURNING id`,
        [input.eventId, input.code, input.name],
      );
      if (!team.rows[0])
        throw new HttpError(
          409,
          'EVENT_NOT_EDITABLE',
          'Teams can only be added before the hunt starts.',
        );
      for (const member of credentials) {
        await client.query(
          `INSERT INTO participants(event_id,team_id,member_code,display_name,password_hash)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            input.eventId,
            team.rows[0].id,
            member.memberCode,
            member.displayName,
            member.passwordHash,
          ],
        );
      }

      // Automatically assign initial locations for each round sequence
      const existingCps = await client.query<{ id: string }>(
        `SELECT id FROM checkpoints WHERE event_id=$1 AND active ORDER BY code, created_at`,
        [input.eventId],
      );
      const existingRounds = await client.query<{ id: string; sequence: number }>(
        `SELECT id, sequence FROM rounds WHERE event_id=$1 ORDER BY sequence`,
        [input.eventId],
      );
      if (existingCps.rows.length > 0 && existingRounds.rows.length > 0) {
        for (const r of existingRounds.rows) {
          const cp = existingCps.rows[(r.sequence - 1) % existingCps.rows.length]!;
          await client.query(
            `INSERT INTO team_round_locations(team_id, round_sequence, checkpoint_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (team_id, round_sequence) DO NOTHING`,
            [team.rows[0].id, r.sequence, cp.id],
          );
        }
      }

      return team.rows[0].id;
    });
    await audit(admin.userId, 'CREATE', 'team', teamId, input.eventId, {
      code: input.code,
      memberCount: input.members.length,
    });
    response.status(201).json({
      data: {
        teamId,
        credentials: credentials.map(({ displayName, memberCode, password }) => ({
          displayName,
          memberCode,
          password,
        })),
      },
    });
  }),
);

adminRouter.get(
  '/admin/overview',
  asyncRoute(async (request, response) => {
    requireAdmin(request);
    const eventId = uuid.parse(request.query.eventId);
    const [event, teams, attempts] = await Promise.all([
      query(`SELECT id,name,slug,status,starts_at,ends_at FROM events WHERE id=$1`, [eventId]),
      query(
        `SELECT t.id,t.code,t.name,tp.status,tp.current_sequence,tp.started_at,tp.completed_at,
      (SELECT count(*)::int FROM participants p WHERE p.team_id=t.id AND p.active) AS member_count
      FROM teams t JOIN team_progress tp ON tp.team_id=t.id WHERE t.event_id=$1 ORDER BY t.code`,
        [eventId],
      ),
      query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE ga.status='passed')::int AS passed
      FROM game_attempts ga JOIN teams t ON t.id=ga.team_id WHERE t.event_id=$1`,
        [eventId],
      ),
    ]);
    if (!event.rows[0]) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    response.json({
      data: { event: event.rows[0], teams: teams.rows, attempts: attempts.rows[0] },
    });
  }),
);

adminRouter.post(
  '/admin/events',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const input = eventSchema.parse(request.body);
    const result = await query<{ id: string }>(
      `INSERT INTO events(name,slug) VALUES ($1,$2) RETURNING id`,
      [input.name, input.slug],
    );
    await audit(admin.userId, 'CREATE', 'event', result.rows[0]!.id, result.rows[0]!.id, input);
    response.status(201).json({ data: result.rows[0] });
  }),
);

adminRouter.post(
  '/admin/events/:eventId/new-hunt',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const sourceEventId = uuid.parse(request.params.eventId);
    const suffix = `${Date.now().toString(36)}-${randomInt(1000, 10000)}`;
    const created = await withTransaction(async (client) => {
      const source = await client.query<{
        name: string;
        slug: string;
        settings: Record<string, unknown>;
        status: string;
      }>(`SELECT name,slug,settings,status FROM events WHERE id=$1 FOR UPDATE`, [sourceEventId]);
      if (!source.rows[0]) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.');
      if (source.rows[0].status !== 'FINISHED')
        throw new HttpError(
          409,
          'INVALID_EVENT_STATE',
          'A new hunt can only be created from a finished event.',
        );

      const existingDraft = await client.query<{ id: string }>(
        `SELECT id FROM events WHERE status='DRAFT' LIMIT 1`,
      );
      if (existingDraft.rows[0])
        throw new HttpError(409, 'DRAFT_EXISTS', 'Finish setting up the existing draft hunt first.');

      const result = await client.query<{ id: string; name: string; slug: string }>(
        `INSERT INTO events(name,slug,settings)
         VALUES ($1,$2,$3) RETURNING id,name,slug`,
        [
          `${source.rows[0].name.slice(0, 109)} - New Hunt`,
          `${source.rows[0].slug.slice(0, 60)}-new-${suffix}`,
          source.rows[0].settings,
        ],
      );
      return result.rows[0]!;
    });

    await audit(admin.userId, 'CREATE_NEW_HUNT', 'event', created.id, created.id, {
      sourceEventId,
    });
    response.status(201).json({ data: created });
  }),
);

adminRouter.patch(
  '/admin/events/:eventId',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const eventId = uuid.parse(request.params.eventId);
    const input = eventSchema
      .partial()
      .extend({ settings: z.record(z.string(), z.unknown()).optional() })
      .parse(request.body);
    const result = await query(
      `UPDATE events SET name=COALESCE($2,name),slug=COALESCE($3,slug),settings=COALESCE($4,settings) WHERE id=$1 AND status='DRAFT' RETURNING id,name,slug,settings`,
      [eventId, input.name ?? null, input.slug ?? null, input.settings ?? null],
    );
    if (!result.rows[0])
      throw new HttpError(409, 'EVENT_NOT_EDITABLE', 'Only draft events can be edited.');
    await audit(admin.userId, 'UPDATE', 'event', eventId, eventId, input);
    response.json({ data: result.rows[0] });
  }),
);

adminRouter.post(
  '/admin/events/:eventId/control',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const eventId = uuid.parse(request.params.eventId);
    const { action, reason } = z
      .object({
        action: z.enum(['START', 'PAUSE', 'RESUME', 'FINISH', 'RESTART']),
        reason: z.string().max(500).optional(),
      })
      .parse(request.body);
    const reset = await withTransaction(async (client) => {
      const event = await client.query<{ status: string }>(
        `SELECT status FROM events WHERE id=$1 FOR UPDATE`,
        [eventId],
      );
      if (!event.rows[0]) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.');
      if (action === 'START') {
        if (event.rows[0].status !== 'DRAFT')
          throw new HttpError(409, 'INVALID_EVENT_STATE', 'Only a draft event can start.');
        const readiness = await client.query<{
          expected_rounds: number;
          rounds: number;
          locations: number;
          games: number;
          teams: number;
          invalid_teams: number;
        }>(
          `
        SELECT COALESCE((SELECT COALESCE((settings->>'roundCount')::int, (settings->>'checkpointCount')::int) FROM events WHERE id=$1), 5) expected_rounds,
          (SELECT count(*)::int FROM rounds WHERE event_id=$1) rounds,
          (SELECT count(*)::int FROM checkpoints WHERE event_id=$1 AND active) locations,
          (SELECT count(*)::int FROM games WHERE enabled) games,
          (SELECT count(*)::int FROM teams WHERE event_id=$1 AND active) teams,
          (SELECT count(*)::int FROM teams t WHERE t.event_id=$1 AND t.active AND (SELECT count(*) FROM participants p WHERE p.team_id=t.id AND p.active) NOT BETWEEN 3 AND 5) invalid_teams
      `,
          [eventId],
        );
        const ready = readiness.rows[0]!;
        const reasons: string[] = [];
        if (ready.rounds !== ready.expected_rounds) {
          reasons.push(
            `Hunt settings expect ${ready.expected_rounds} rounds, but found ${ready.rounds} rounds configured. Please click "Update Structure" or adjust rounds.`,
          );
        }
        if (ready.locations < 1) {
          reasons.push('At least 1 active checkpoint/location is required.');
        }
        if (ready.games < ready.expected_rounds) {
          reasons.push(
            `At least ${ready.expected_rounds} enabled games are required (currently ${ready.games} enabled).`,
          );
        }
        if (ready.teams < 1) {
          reasons.push('At least 1 active team is required before starting the hunt.');
        }
        if (ready.invalid_teams > 0) {
          const invalidTeamRows = await client.query<{ name: string; member_count: number }>(
            `SELECT t.name, count(p.id)::int as member_count
             FROM teams t
             LEFT JOIN participants p ON p.team_id=t.id AND p.active
             WHERE t.event_id=$1 AND t.active
             GROUP BY t.id, t.name
             HAVING count(p.id) NOT BETWEEN 3 AND 5`,
            [eventId],
          );
          const details = invalidTeamRows.rows
            .map((r) => `"${r.name}" (${r.member_count} member${r.member_count === 1 ? '' : 's'})`)
            .join(', ');
          reasons.push(
            `Every team must have between 3 and 5 members. Invalid team(s): ${details}.`,
          );
        }
        if (reasons.length > 0)
          throw new HttpError(
            409,
            'EVENT_NOT_READY',
            reasons.join(' '),
            { ...ready, reasons },
          );
        await client.query(`UPDATE events SET status='RUNNING',starts_at=now() WHERE id=$1`, [
          eventId,
        ]);
      } else if (action === 'PAUSE') {
        if (event.rows[0].status !== 'RUNNING')
          throw new HttpError(409, 'INVALID_EVENT_STATE', 'Only a running event can pause.');
        await client.query(
          `INSERT INTO event_pauses(event_id,started_at,reason,created_by) VALUES ($1,now(),$2,$3)`,
          [eventId, reason ?? 'Organizer pause', admin.userId],
        );
        await client.query(`UPDATE events SET status='PAUSED' WHERE id=$1`, [eventId]);
      } else if (action === 'RESUME') {
        if (event.rows[0].status !== 'PAUSED')
          throw new HttpError(409, 'INVALID_EVENT_STATE', 'Only a paused event can resume.');
        await client.query(
          `UPDATE event_pauses SET ended_at=now() WHERE event_id=$1 AND ended_at IS NULL`,
          [eventId],
        );
        await client.query(`UPDATE events SET status='RUNNING' WHERE id=$1`, [eventId]);
      } else if (action === 'FINISH') {
        if (!['RUNNING', 'PAUSED'].includes(event.rows[0].status))
          throw new HttpError(409, 'INVALID_EVENT_STATE', 'This event cannot finish.');
        await client.query(
          `UPDATE event_pauses SET ended_at=now() WHERE event_id=$1 AND ended_at IS NULL`,
          [eventId],
        );
        await client.query(`UPDATE events SET status='FINISHED',ends_at=now() WHERE id=$1`, [
          eventId,
        ]);
      } else {
        if (event.rows[0].status !== 'FINISHED')
          throw new HttpError(409, 'INVALID_EVENT_STATE', 'Only a finished hunt can restart.');

        const attempts = await client.query(
          `DELETE FROM game_attempts ga USING teams t
           WHERE ga.team_id=t.id AND t.event_id=$1`,
          [eventId],
        );
        const assignments = await client.query(
          `DELETE FROM game_assignments a USING teams t
           WHERE a.team_id=t.id AND t.event_id=$1`,
          [eventId],
        );
        const teams = await client.query(
          `UPDATE team_progress tp
           SET current_sequence=1,status='NOT_STARTED',started_at=NULL,completed_at=NULL,updated_at=now()
           FROM teams t WHERE tp.team_id=t.id AND t.event_id=$1`,
          [eventId],
        );
        await client.query(`DELETE FROM event_pauses WHERE event_id=$1`, [eventId]);
        await client.query(
          `UPDATE sessions s SET revoked_at=now() FROM participants p
           WHERE s.participant_id=p.id AND p.event_id=$1 AND s.revoked_at IS NULL`,
          [eventId],
        );
        await client.query(
          `UPDATE events SET status='DRAFT',starts_at=NULL,ends_at=NULL WHERE id=$1`,
          [eventId],
        );
        return {
          attempts: attempts.rowCount ?? 0,
          assignments: assignments.rowCount ?? 0,
          teams: teams.rowCount ?? 0,
        };
      }
      return null;
    });
    await audit(admin.userId, action, 'event', eventId, eventId, { reason, reset });
    response.json({ data: { eventId, action, reset } });
  }),
);

adminRouter.post(
  '/admin/events/:eventId/reset',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const eventId = uuid.parse(request.params.eventId);
    const input = z
      .object({
        target: z.enum(['locations', 'teams', 'rounds', 'all']),
        confirmationText: z.string().trim(),
      })
      .parse(request.body);

    const expectedPhrases: Record<string, string[]> = {
      locations: ['RESET LOCATIONS', 'RESET'],
      teams: ['RESET TEAMS', 'RESET'],
      rounds: ['RESET ROUNDS', 'RESET'],
      all: ['RESET ALL', 'RESET'],
    };
    const upperConfirm = input.confirmationText.toUpperCase();
    if (!expectedPhrases[input.target]?.includes(upperConfirm)) {
      throw new HttpError(
        400,
        'INVALID_CONFIRMATION',
        `Type "${input.target === 'all' ? 'RESET ALL' : `RESET ${input.target.toUpperCase()}`}" to confirm reset.`,
      );
    }

    const result = await withTransaction(async (client) => {
      const event = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM events WHERE id=$1 FOR UPDATE`,
        [eventId],
      );
      if (!event.rows[0]) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.');

      if (input.target === 'teams' || input.target === 'all') {
        await client.query(
          `DELETE FROM sessions s USING participants p
           WHERE s.participant_id=p.id AND p.event_id=$1`,
          [eventId],
        );
        await client.query(
          `DELETE FROM game_attempts ga USING teams t
           WHERE ga.team_id=t.id AND t.event_id=$1`,
          [eventId],
        );
        await client.query(
          `DELETE FROM game_assignments a USING teams t
           WHERE a.team_id=t.id AND t.event_id=$1`,
          [eventId],
        );
        await client.query(
          `DELETE FROM team_round_clues trc USING teams t
           WHERE trc.team_id=t.id AND t.event_id=$1`,
          [eventId],
        );
        await client.query(
          `DELETE FROM team_round_locations trl USING teams t
           WHERE trl.team_id=t.id AND t.event_id=$1`,
          [eventId],
        );
        await client.query(
          `DELETE FROM team_checkpoint_qrs tcq USING teams t
           WHERE tcq.team_id=t.id AND t.event_id=$1`,
          [eventId],
        );
        await client.query(
          `DELETE FROM team_progress tp USING teams t
           WHERE tp.team_id=t.id AND t.event_id=$1`,
          [eventId],
        );
        await client.query(`DELETE FROM participants WHERE event_id=$1`, [eventId]);
        await client.query(`DELETE FROM teams WHERE event_id=$1`, [eventId]);
      }

      if (input.target === 'rounds' || input.target === 'all') {
        await client.query(
          `DELETE FROM game_attempts ga USING game_assignments a, rounds r
           WHERE ga.assignment_id=a.id AND a.round_id=r.id AND r.event_id=$1`,
          [eventId],
        );
        await client.query(
          `DELETE FROM game_assignments a USING rounds r
           WHERE a.round_id=r.id AND r.event_id=$1`,
          [eventId],
        );
        await client.query(
          `DELETE FROM team_round_clues trc USING rounds r
           WHERE trc.round_id=r.id AND r.event_id=$1`,
          [eventId],
        );
        await client.query(
          `DELETE FROM team_round_locations trl USING teams t
           WHERE trl.team_id=t.id AND t.event_id=$1`,
          [eventId],
        );
        await client.query(`DELETE FROM rounds WHERE event_id=$1`, [eventId]);
        await client.query(
          `UPDATE team_progress tp
           SET current_sequence=1, status='NOT_STARTED', started_at=NULL, completed_at=NULL
           FROM teams t WHERE tp.team_id=t.id AND t.event_id=$1`,
          [eventId],
        );
        await client.query(
          `UPDATE events SET settings = settings || '{"roundCount": 0, "checkpointCount": 0}'::jsonb WHERE id=$1`,
          [eventId],
        );
      }

      if (input.target === 'locations' || input.target === 'all') {
        await client.query(
          `UPDATE rounds SET checkpoint_id=NULL WHERE event_id=$1`,
          [eventId],
        );
        await client.query(
          `DELETE FROM team_checkpoint_qrs tcq USING checkpoints c
           WHERE tcq.checkpoint_id=c.id AND c.event_id=$1`,
          [eventId],
        );
        await client.query(
          `DELETE FROM team_round_locations trl USING checkpoints c
           WHERE trl.checkpoint_id=c.id AND c.event_id=$1`,
          [eventId],
        );
        await client.query(`DELETE FROM checkpoints WHERE event_id=$1`, [eventId]);
        await client.query(
          `UPDATE events SET settings = settings || '{"locationCount": 0}'::jsonb WHERE id=$1`,
          [eventId],
        );
      }

      if (input.target === 'all') {
        await client.query(`DELETE FROM event_pauses WHERE event_id=$1`, [eventId]);
        await client.query(
          `UPDATE events
           SET status='DRAFT', starts_at=NULL, ends_at=NULL,
               settings='{"roundCount":0,"locationCount":0,"checkpointCount":0,"retryCooldownSeconds":10,"maxAttempts":5}'::jsonb
           WHERE id=$1`,
          [eventId],
        );
      } else if (event.rows[0].status !== 'DRAFT') {
        // If critical structure is reset during running/paused event, revert to draft
        await client.query(
          `UPDATE events SET status='DRAFT', starts_at=NULL, ends_at=NULL WHERE id=$1`,
          [eventId],
        );
      }

      return {
        eventId,
        target: input.target,
        deleted: true,
      };
    });

    await audit(admin.userId, `RESET_${input.target.toUpperCase()}`, 'event', eventId, eventId, {
      target: input.target,
    });

    response.json({
      data: {
        ...result,
        message:
          input.target === 'all'
            ? 'The entire hunt has been reset to an initial clean draft.'
            : `All ${input.target} have been successfully reset.`,
      },
    });
  }),
);

adminRouter.patch(
  ['/admin/events/:eventId/checkpoint-count', '/admin/events/:eventId/structure'],
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const eventId = uuid.parse(request.params.eventId);
    const input = z
      .object({
        roundCount: z.number().int().min(1).max(16).optional(),
        locationCount: z.number().int().min(1).max(20).optional(),
        checkpointCount: z.number().int().min(1).max(20).optional(),
      })
      .parse(request.body);

    const result = await withTransaction(async (client) => {
      const event = await client.query<{
        status: string;
        round_count: number;
        location_count: number;
      }>(
        `SELECT status,
           COALESCE((settings->>'roundCount')::int, (settings->>'checkpointCount')::int, (SELECT count(*)::int FROM rounds WHERE event_id=$1), 5) AS round_count,
           COALESCE((settings->>'locationCount')::int, (SELECT count(*)::int FROM checkpoints WHERE event_id=$1 AND active), (settings->>'checkpointCount')::int, 5) AS location_count
         FROM events WHERE id=$1 FOR UPDATE`,
        [eventId],
      );
      if (!event.rows[0]) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.');
      if (event.rows[0].status === 'FINISHED') {
        throw new HttpError(409, 'EVENT_FINISHED', 'Hunt configuration cannot be changed after the hunt ends.');
      }

      const prevRoundCount = event.rows[0].round_count;
      const prevLocCount = event.rows[0].location_count;

      const targetRoundCount =
        input.roundCount ?? (input.checkpointCount !== undefined ? input.checkpointCount : prevRoundCount);
      const targetLocCount =
        input.locationCount ??
        (input.checkpointCount !== undefined && input.roundCount === undefined
          ? input.checkpointCount
          : prevLocCount);

      // 1. Handle locationCount changes
      const allExistingCps = await client.query<{ id: string; code: string }>(
        `SELECT id, code FROM checkpoints WHERE event_id=$1 AND active ORDER BY code, created_at`,
        [eventId],
      );
      const currentLocCount = allExistingCps.rows.length;

      if (targetLocCount < currentLocCount) {
        const toRemove = allExistingCps.rows.slice(targetLocCount);
        const removedIds = toRemove.map((c) => c.id);

        const inUse = await client.query<{ code: string }>(
          `SELECT t.code FROM teams t
           JOIN team_progress tp ON tp.team_id=t.id
           JOIN team_round_locations trl ON trl.team_id=t.id AND trl.round_sequence=tp.current_sequence
           WHERE t.event_id=$1 AND t.active AND trl.checkpoint_id=ANY($2::uuid[])
           LIMIT 1`,
          [eventId, removedIds],
        );
        if (inUse.rows[0]) {
          throw new HttpError(
            409,
            'LOCATIONS_IN_USE',
            `Cannot reduce locations because team ${inUse.rows[0].code} is currently assigned to a removed location.`,
          );
        }

        await client.query(`DELETE FROM checkpoints WHERE id=ANY($1::uuid[])`, [removedIds]);

        const firstCp = allExistingCps.rows[0];
        if (firstCp) {
          await client.query(
            `UPDATE team_round_locations SET checkpoint_id=$2 WHERE checkpoint_id=ANY($1::uuid[])`,
            [removedIds, firstCp.id],
          );
        } else {
          await client.query(`DELETE FROM team_round_locations WHERE checkpoint_id=ANY($1::uuid[])`, [
            removedIds,
          ]);
        }
      } else if (targetLocCount > currentLocCount) {
        for (let locIdx = currentLocCount + 1; locIdx <= targetLocCount; locIdx += 1) {
          const token = createToken(24);
          await client.query(
            `INSERT INTO checkpoints(event_id,code,label,clue,note,show_note_to_player,qr_token,qr_token_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              eventId,
              `LOC-${locIdx}`,
              `Location ${locIdx}`,
              `Proceed to Location ${locIdx}.`,
              '',
              false,
              token,
              hashToken(token),
            ],
          );
        }
      }

      // 2. Handle roundCount changes
      if (targetRoundCount < prevRoundCount) {
        const blocked = await client.query<{ code: string }>(
          `SELECT t.code FROM teams t JOIN team_progress tp ON tp.team_id=t.id
           WHERE t.event_id=$1 AND t.active
             AND (tp.status='COMPLETED' OR tp.current_sequence>$2)
           ORDER BY t.code LIMIT 1`,
          [eventId, targetRoundCount],
        );
        if (blocked.rows[0]) {
          throw new HttpError(
            409,
            'ROUNDS_IN_USE',
            `Round count cannot be reduced because team ${blocked.rows[0].code} has already progressed beyond it.`,
          );
        }

        const assigned = await client.query<{ id: string }>(
          `SELECT a.id FROM game_assignments a JOIN rounds r ON r.id=a.round_id
           WHERE r.event_id=$1 AND r.sequence>$2 LIMIT 1`,
          [eventId, targetRoundCount],
        );
        if (assigned.rows[0]) {
          throw new HttpError(
            409,
            'ROUNDS_IN_USE',
            'Round count cannot be reduced because a removed round already has game activity.',
          );
        }

        await client.query(`DELETE FROM rounds WHERE event_id=$1 AND sequence>$2`, [
          eventId,
          targetRoundCount,
        ]);
        await client.query(
          `DELETE FROM team_round_locations trl USING teams t
           WHERE trl.team_id = t.id AND t.event_id = $1 AND trl.round_sequence > $2`,
          [eventId, targetRoundCount],
        );
      } else if (targetRoundCount > prevRoundCount) {
        const availableCps = await client.query<{ id: string }>(
          `SELECT id FROM checkpoints WHERE event_id=$1 AND active ORDER BY code, created_at`,
          [eventId],
        );
        for (let seq = prevRoundCount + 1; seq <= targetRoundCount; seq += 1) {
          const difficulty =
            seq <= Math.ceil(targetRoundCount / 3)
              ? 'easy'
              : seq <= Math.ceil((targetRoundCount * 2) / 3)
                ? 'medium'
                : 'hard';
          const defaultCpId = availableCps.rows.length
            ? availableCps.rows[(seq - 1) % availableCps.rows.length]!.id
            : null;
          await client.query(
            `INSERT INTO rounds(event_id,checkpoint_id,sequence,clue,difficulty)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              eventId,
              defaultCpId,
              seq,
              `Proceed to your assigned location for Round ${seq}.`,
              difficulty,
            ],
          );
        }

        // Auto-seed team_round_locations for existing teams for new sequences
        const existingTeams = await client.query<{ id: string }>(
          `SELECT id FROM teams WHERE event_id=$1 AND active`,
          [eventId],
        );
        if (availableCps.rows.length > 0) {
          for (const t of existingTeams.rows) {
            for (let seq = prevRoundCount + 1; seq <= targetRoundCount; seq += 1) {
              const cp = availableCps.rows[(seq - 1) % availableCps.rows.length]!;
              await client.query(
                `INSERT INTO team_round_locations(team_id, round_sequence, checkpoint_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (team_id, round_sequence) DO NOTHING`,
                [t.id, seq, cp.id],
              );
            }
          }
        }
      }

      await client.query(
        `UPDATE events
         SET settings = settings || jsonb_build_object(
           'roundCount', $2::int,
           'locationCount', $3::int,
           'checkpointCount', $2::int
         )
         WHERE id=$1`,
        [eventId, targetRoundCount, targetLocCount],
      );

      const allCps = await client.query<{ id: string; label: string; code: string }>(
        `SELECT id, label, code FROM checkpoints WHERE event_id=$1 AND active ORDER BY code, created_at`,
        [eventId],
      );

      return {
        prevRoundCount,
        prevLocCount,
        roundCount: targetRoundCount,
        locationCount: targetLocCount,
        checkpointCount: targetRoundCount,
        checkpoints: allCps.rows,
      };
    });

    await audit(admin.userId, 'CHANGE_HUNT_STRUCTURE', 'event', eventId, eventId, {
      roundCount: result.roundCount,
      locationCount: result.locationCount,
    });
    response.json({
      data: {
        roundCount: result.roundCount,
        locationCount: result.locationCount,
        checkpointCount: result.checkpointCount,
        checkpoints: result.checkpoints,
      },
    });
  }),
);

adminRouter.post(
  '/admin/assignments/:assignmentId/attempts/reset',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const assignmentId = uuid.parse(request.params.assignmentId);
    const result = await withTransaction(async (client) => {
      const assignment = await client.query<{
        event_id: string;
        team_id: string;
        status: string;
      }>(
        `SELECT t.event_id,a.team_id,a.status FROM game_assignments a
         JOIN teams t ON t.id=a.team_id JOIN events e ON e.id=t.event_id
         WHERE a.id=$1 AND e.status<>'FINISHED' FOR UPDATE OF a`,
        [assignmentId],
      );
      if (!assignment.rows[0]) {
        throw new HttpError(404, 'ASSIGNMENT_NOT_FOUND', 'Active assignment not found.');
      }
      if (assignment.rows[0].status !== 'ASSIGNED') {
        throw new HttpError(409, 'ASSIGNMENT_CLOSED', 'Attempts can only be reset for an active assignment.');
      }
      const reset = await client.query(
        `UPDATE game_attempts SET status='cancelled',ended_at=COALESCE(ended_at,now()),
           duration_ms=COALESCE(duration_ms,(extract(epoch FROM(now()-started_at))*1000)::bigint),
           result_metadata=jsonb_build_object('reason','admin_reset')
         WHERE assignment_id=$1 AND status<>'cancelled'`,
        [assignmentId],
      );
      return { ...assignment.rows[0], resetCount: reset.rowCount ?? 0 };
    });
    await audit(admin.userId, 'RESET_ATTEMPTS', 'game_assignment', assignmentId, result.event_id, {
      teamId: result.team_id,
      resetCount: result.resetCount,
    });
    response.json({ data: { assignmentId, resetCount: result.resetCount } });
  }),
);

adminRouter.post(
  '/admin/teams',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const input = teamSchema.parse(request.body);
    const result = await query<{ id: string }>(
      `INSERT INTO teams(event_id,code,name) SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM events WHERE id=$1 AND status='DRAFT') RETURNING id`,
      [input.eventId, input.code, input.name],
    );
    if (!result.rows[0])
      throw new HttpError(409, 'EVENT_NOT_EDITABLE', 'Teams can only be added to a draft event.');
    await audit(admin.userId, 'CREATE', 'team', result.rows[0].id, input.eventId, input);
    response.status(201).json({ data: result.rows[0] });
  }),
);

adminRouter.get(
  '/admin/teams',
  asyncRoute(async (request, response) => {
    requireAdmin(request);
    const eventId = uuid.parse(request.query.eventId);
    const search = z.string().max(100).catch('').parse(request.query.search);
    const result = await query(
      `SELECT t.id,t.code,t.name,t.active,tp.status,tp.current_sequence,
    json_agg(json_build_object('id',p.id,'memberCode',p.member_code,'displayName',p.display_name,'active',p.active) ORDER BY p.member_code) FILTER (WHERE p.id IS NOT NULL) AS participants
    FROM teams t JOIN team_progress tp ON tp.team_id=t.id LEFT JOIN participants p ON p.team_id=t.id
    WHERE t.event_id=$1 AND ($2='' OR t.code ILIKE '%'||$2||'%' OR t.name ILIKE '%'||$2||'%')
    GROUP BY t.id,tp.status,tp.current_sequence ORDER BY t.code`,
      [eventId, search],
    );
    response.json({ data: result.rows });
  }),
);

adminRouter.patch(
  '/admin/teams/:teamId',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const teamId = uuid.parse(request.params.teamId);
    const input = z
      .object({
        code: z.string().trim().min(2).max(30).optional(),
        name: z.string().trim().min(2).max(100).optional(),
      })
      .refine((value) => value.code !== undefined || value.name !== undefined, {
        message: 'Provide a team code or name to update.',
      })
      .parse(request.body);
    const result = await query<{ event_id: string; code: string; name: string }>(
      `UPDATE teams t
       SET code=COALESCE($2,t.code),name=COALESCE($3,t.name)
       FROM events e
       WHERE t.id=$1 AND e.id=t.event_id AND e.status='DRAFT'
       RETURNING t.event_id,t.code,t.name`,
      [teamId, input.code ?? null, input.name ?? null],
    );
    if (!result.rows[0]) {
      throw new HttpError(
        409,
        'TEAM_NOT_EDITABLE',
        'Teams can only be edited before the hunt starts.',
      );
    }
    await audit(admin.userId, 'UPDATE', 'team', teamId, result.rows[0].event_id, input);
    response.json({ data: { id: teamId, code: result.rows[0].code, name: result.rows[0].name } });
  }),
);

adminRouter.delete(
  '/admin/teams/:teamId',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const teamId = uuid.parse(request.params.teamId);
    const eventId = await withTransaction(async (client) => {
      const team = await client.query<{ event_id: string }>(
        `SELECT t.event_id FROM teams t JOIN events e ON e.id=t.event_id
         WHERE t.id=$1 AND e.status='DRAFT' FOR UPDATE OF t`,
        [teamId],
      );
      if (!team.rows[0]) {
        throw new HttpError(
          409,
          'TEAM_NOT_DELETABLE',
          'Teams can only be deleted before the hunt starts.',
        );
      }
      await client.query(
        `DELETE FROM sessions WHERE participant_id IN (SELECT id FROM participants WHERE team_id=$1)`,
        [teamId],
      );
      await client.query(`DELETE FROM participants WHERE team_id=$1`, [teamId]);
      await client.query(`DELETE FROM teams WHERE id=$1`, [teamId]);
      return team.rows[0].event_id;
    });
    await audit(admin.userId, 'DELETE', 'team', teamId, eventId, {});
    response.status(204).end();
  }),
);

adminRouter.get(
  '/admin/teams/:teamId/rounds',
  asyncRoute(async (request, response) => {
    requireAdmin(request);
    const teamId = uuid.parse(request.params.teamId);

    const team = await query<{
      id: string;
      code: string;
      name: string;
      event_id: string;
      status: string;
      current_sequence: number;
      started_at: string | null;
      completed_at: string | null;
    }>(
      `SELECT t.id, t.code, t.name, t.event_id, tp.status, tp.current_sequence, tp.started_at, tp.completed_at
       FROM teams t
       JOIN team_progress tp ON tp.team_id = t.id
       WHERE t.id = $1`,
      [teamId],
    );

    if (!team.rows[0]) {
      throw new HttpError(404, 'TEAM_NOT_FOUND', 'Team not found.');
    }

    const rounds = await query<{
      round: number;
      checkpoint_label: string;
      game_name: string | null;
      game_code: string | null;
      assignment_id: string | null;
      assignment_status: string | null;
      passed_at: string | null;
      attempts: Array<{
        id: string;
        attempt_number: number;
        status: string;
        started_at: string;
        ended_at: string | null;
        duration_ms: number | null;
        member_code: string;
        display_name: string;
      }>;
    }>(
      `SELECT
        r.sequence AS round,
        c.label AS checkpoint_label,
        g.name AS game_name,
        g.code AS game_code,
        a.id AS assignment_id,
        a.status AS assignment_status,
        a.passed_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id', x.id,
              'attempt_number', x.attempt_number,
              'status', x.status,
              'started_at', x.started_at,
              'ended_at', x.ended_at,
              'duration_ms', x.duration_ms,
              'member_code', p.member_code,
              'display_name', p.display_name
            ) ORDER BY x.attempt_number
          ) FILTER (WHERE x.id IS NOT NULL),
          '[]'::json
        ) AS attempts
      FROM rounds r
      LEFT JOIN team_round_locations trl ON trl.team_id = $1 AND trl.round_sequence = r.sequence
      LEFT JOIN checkpoints c ON c.id = COALESCE(trl.checkpoint_id, r.checkpoint_id)
      LEFT JOIN game_assignments a ON a.team_id = $1 AND a.round_id = r.id
      LEFT JOIN games g ON g.id = a.game_id
      LEFT JOIN game_attempts x ON x.assignment_id = a.id
      LEFT JOIN participants p ON p.id = x.participant_id
      WHERE r.event_id = $2
      GROUP BY r.sequence, c.label, g.name, g.code, a.id, a.status, a.passed_at
      ORDER BY r.sequence`,
      [teamId, team.rows[0].event_id],
    );

    response.json({
      data: {
        team: team.rows[0],
        rounds: rounds.rows,
      },
    });
  }),
);

adminRouter.post(
  '/admin/teams/:teamId/participants',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const teamId = uuid.parse(request.params.teamId);
    const input = participantSchema.parse(request.body);
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const result = await query<{ id: string; event_id: string }>(
      `INSERT INTO participants(event_id,team_id,member_code,display_name,password_hash)
    SELECT t.event_id,t.id,$2,$3,$4 FROM teams t WHERE t.id=$1 AND t.active AND (SELECT count(*) FROM participants p WHERE p.team_id=t.id AND p.active)<5
    RETURNING id,event_id`,
      [teamId, input.memberCode, input.displayName, passwordHash],
    );
    if (!result.rows[0])
      throw new HttpError(409, 'TEAM_FULL_OR_INACTIVE', 'The team is full or unavailable.');
    await audit(admin.userId, 'CREATE', 'participant', result.rows[0].id, result.rows[0].event_id, {
      memberCode: input.memberCode,
    });
    response.status(201).json({ data: { id: result.rows[0].id } });
  }),
);

adminRouter.patch(
  '/admin/participants/:participantId',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const participantId = uuid.parse(request.params.participantId);
    const input = z
      .object({
        displayName: z.string().min(2).max(100).optional(),
        active: z.boolean().optional(),
        password: z.string().min(6).max(200).optional(),
      })
      .parse(request.body);
    const passwordHash = input.password
      ? await argon2.hash(input.password, { type: argon2.argon2id })
      : null;
    const result = await query<{ event_id: string }>(
      `UPDATE participants SET display_name=COALESCE($2,display_name),active=COALESCE($3,active),password_hash=COALESCE($4,password_hash) WHERE id=$1 RETURNING event_id`,
      [participantId, input.displayName ?? null, input.active ?? null, passwordHash],
    );
    if (!result.rows[0])
      throw new HttpError(404, 'PARTICIPANT_NOT_FOUND', 'Participant not found.');
    if (input.active === false || input.password)
      await query(
        `UPDATE sessions SET revoked_at=now() WHERE participant_id=$1 AND revoked_at IS NULL`,
        [participantId],
      );
    await audit(admin.userId, 'UPDATE', 'participant', participantId, result.rows[0].event_id, {
      ...input,
      password: input.password ? '[REDACTED]' : undefined,
    });
    response.json({ data: { id: participantId } });
  }),
);

adminRouter.post(
  '/admin/participants/:participantId/password',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const participantId = uuid.parse(request.params.participantId);
    const input = z
      .object({
        password: z.string().min(6).max(200).optional(),
      })
      .parse(request.body ?? {});

    const newPassword = input.password ?? `Hunt-${randomInt(100000, 1000000)}!`;
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });

    const result = await query<{
      event_id: string;
      member_code: string;
      display_name: string;
    }>(
      `UPDATE participants SET password_hash=$2 WHERE id=$1 RETURNING event_id, member_code, display_name`,
      [participantId, passwordHash],
    );
    if (!result.rows[0]) {
      throw new HttpError(404, 'PARTICIPANT_NOT_FOUND', 'Participant not found.');
    }

    await query(
      `UPDATE sessions SET revoked_at=now() WHERE participant_id=$1 AND revoked_at IS NULL`,
      [participantId],
    );

    await audit(admin.userId, 'RESET_PASSWORD', 'participant', participantId, result.rows[0].event_id, {
      memberCode: result.rows[0].member_code,
      displayName: result.rows[0].display_name,
    });

    response.json({
      data: {
        id: participantId,
        memberCode: result.rows[0].member_code,
        displayName: result.rows[0].display_name,
        password: newPassword,
      },
    });
  }),
);

adminRouter.post(
  '/admin/participants/:participantId/logout',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const participantId = uuid.parse(request.params.participantId);
    const result = await query<{ event_id: string; member_code: string; display_name: string }>(
      `SELECT event_id, member_code, display_name FROM participants WHERE id = $1`,
      [participantId],
    );
    if (!result.rows[0]) {
      throw new HttpError(404, 'PARTICIPANT_NOT_FOUND', 'Participant not found.');
    }
    await query(
      `UPDATE sessions SET revoked_at=now() WHERE participant_id=$1 AND revoked_at IS NULL`,
      [participantId],
    );
    await audit(admin.userId, 'LOGOUT_PARTICIPANT', 'participant', participantId, result.rows[0].event_id, {
      memberCode: result.rows[0].member_code,
      displayName: result.rows[0].display_name,
    });
    response.json({ data: { id: participantId, loggedOut: true } });
  }),
);

adminRouter.patch(
  '/admin/account/password',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const input = z
      .object({
        password: z.string().min(8).max(200),
      })
      .parse(request.body);
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    await query(`UPDATE admin_users SET password_hash=$1 WHERE id=$2`, [
      passwordHash,
      admin.userId,
    ]);
    await audit(admin.userId, 'CHANGE_PASSWORD', 'admin_user', admin.userId, null, {});
    response.json({ data: { updated: true } });
  }),
);

adminRouter.patch(
  '/admin/account/credentials',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const input = z
      .object({
        username: z
          .string()
          .trim()
          .min(3)
          .max(64)
          .regex(/^[A-Za-z0-9@._-]+$/),
        password: z.string().min(8).max(200),
      })
      .parse(request.body);

    const duplicate = await query<{ id: string }>(
      `SELECT id FROM admin_users WHERE email=$1 AND id<>$2 LIMIT 1`,
      [input.username, admin.userId],
    );
    if (duplicate.rows[0]) {
      throw new HttpError(409, 'USERNAME_TAKEN', 'That admin username is already in use.');
    }

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    await query(`UPDATE admin_users SET email=$1,password_hash=$2 WHERE id=$3`, [
      input.username,
      passwordHash,
      admin.userId,
    ]);
    await audit(admin.userId, 'CHANGE_CREDENTIALS', 'admin_user', admin.userId, null, {
      username: input.username,
    });
    response.json({ data: { updated: true, username: input.username } });
  }),
);

adminRouter.post(
  '/admin/checkpoints',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const input = checkpointSchema.parse(request.body);
    const result = await query<{ id: string }>(
      `INSERT INTO checkpoints(event_id,code,label,qr_token_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.eventId, input.code, input.label, hashToken(createToken(24))],
    );
    await audit(admin.userId, 'CREATE', 'checkpoint', result.rows[0]!.id, input.eventId, {
      code: input.code,
    });
    response.status(201).json({
      data: { id: result.rows[0]!.id },
    });
  }),
);

adminRouter.patch(
  '/admin/checkpoints/:checkpointId',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const checkpointId = uuid.parse(request.params.checkpointId);
    const input = z
      .object({
        label: z.string().trim().min(1).max(120).optional(),
        clue: z.string().trim().max(2000).optional(),
        note: z.string().trim().max(5000).optional(),
        showNoteToPlayer: z.boolean().optional(),
        active: z.boolean().optional(),
        rotateToken: z.boolean().optional(),
        teamId: uuid.optional(),
        difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
      })
      .parse(request.body);

    const token = input.rotateToken ? createToken(24) : null;
    const result = await query<{
      event_id: string;
      code: string;
      label: string;
      clue: string;
      note: string;
      show_note_to_player: boolean;
      qr_token: string;
    }>(
      `UPDATE checkpoints c
       SET label=COALESCE($2,c.label),
           clue=COALESCE($3,c.clue),
           note=COALESCE($4,c.note),
           show_note_to_player=COALESCE($5,c.show_note_to_player),
           active=COALESCE($6,c.active),
           qr_token=CASE WHEN $7::boolean THEN $8 ELSE c.qr_token END,
           qr_token_hash=CASE WHEN $7::boolean THEN $9 ELSE c.qr_token_hash END
       FROM events e WHERE c.id=$1 AND e.id=c.event_id AND e.status<>'FINISHED'
       RETURNING c.event_id, c.code, c.label, c.clue, c.note, c.show_note_to_player, c.qr_token`,
      [
        checkpointId,
        input.label ?? null,
        input.clue ?? null,
        input.note ?? null,
        input.showNoteToPlayer ?? null,
        input.active ?? null,
        Boolean(token),
        token,
        token ? hashToken(token) : null,
      ],
    );
    if (!result.rows[0])
      throw new HttpError(
        409,
        'CHECKPOINT_NOT_EDITABLE',
        'Locations and checkpoints cannot be changed after the hunt is finished.',
      );

    const updated = result.rows[0];

    if (input.clue !== undefined) {
      await query(
        `UPDATE rounds SET clue=$2 WHERE checkpoint_id=$1 AND event_id=$3`,
        [checkpointId, input.clue, updated.event_id],
      );
    }

    if (input.difficulty !== undefined) {
      await query(
        `UPDATE rounds SET difficulty=$2 WHERE checkpoint_id=$1 AND event_id=$3`,
        [checkpointId, input.difficulty, updated.event_id],
      );
    }

    if (token && input.teamId) {
      await query(
        `INSERT INTO team_checkpoint_qrs(team_id,checkpoint_id,qr_token_hash)
         SELECT t.id,c.id,$3 FROM teams t JOIN checkpoints c ON c.event_id=t.event_id
         JOIN events e ON e.id=t.event_id
         WHERE t.id=$1 AND c.id=$2 AND t.active AND e.status<>'FINISHED'
         ON CONFLICT(team_id,checkpoint_id) DO UPDATE
         SET qr_token_hash=EXCLUDED.qr_token_hash,updated_at=now()`,
        [input.teamId, checkpointId, hashToken(token)],
      );
    }

    await audit(admin.userId, 'UPDATE', 'checkpoint', checkpointId, updated.event_id, input);
    response.json({
      data: {
        id: checkpointId,
        code: updated.code,
        label: updated.label,
        clue: updated.clue,
        note: updated.note,
        showNoteToPlayer: updated.show_note_to_player,
        qrToken: updated.qr_token,
        scanUrl: updated.qr_token
          ? `${env.FRONTEND_ORIGIN}/scan?token=${encodeURIComponent(updated.qr_token)}`
          : '',
        ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
      },
    });
  }),
);

adminRouter.post(
  '/admin/events/:eventId/team-round-locations',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const eventId = uuid.parse(request.params.eventId);
    const input = z
      .object({
        mappings: z
          .array(
            z.object({
              teamId: uuid,
              roundSequence: z.number().int().min(1).max(16),
              checkpointId: uuid,
            }),
          )
          .min(1),
      })
      .parse(request.body);

    await withTransaction(async (client) => {
      const event = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM events WHERE id=$1`,
        [eventId],
      );
      if (!event.rows[0]) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.');
      if (event.rows[0].status === 'FINISHED')
        throw new HttpError(409, 'EVENT_FINISHED', 'Cannot modify routes for a finished event.');

      for (const item of input.mappings) {
        await client.query(
          `INSERT INTO team_round_locations(team_id, round_sequence, checkpoint_id, updated_at)
           SELECT t.id, $2, c.id, now()
           FROM teams t, checkpoints c
           WHERE t.id = $1 AND t.event_id = $4 AND t.active
             AND c.id = $3 AND c.event_id = $4 AND c.active
           ON CONFLICT (team_id, round_sequence)
           DO UPDATE SET checkpoint_id = EXCLUDED.checkpoint_id, updated_at = now()`,
          [item.teamId, item.roundSequence, item.checkpointId, eventId],
        );
      }
    });

    await audit(admin.userId, 'UPDATE_TEAM_ROUND_LOCATIONS', 'event', eventId, eventId, {
      count: input.mappings.length,
    });
    response.json({ data: { updated: true, count: input.mappings.length } });
  }),
);

adminRouter.post(
  '/admin/rounds',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const input = roundSchema.parse(request.body);
    const result = await query<{ id: string }>(
      `INSERT INTO rounds(event_id,checkpoint_id,sequence,clue,difficulty)
    SELECT $1,c.id,$3,$4,$5 FROM checkpoints c JOIN events e ON e.id=c.event_id
    WHERE c.id=$2 AND c.event_id=$1 AND e.status='DRAFT' RETURNING id`,
      [input.eventId, input.checkpointId, input.sequence, input.clue, input.difficulty],
    );
    if (!result.rows[0])
      throw new HttpError(
        409,
        'CHECKPOINT_EVENT_MISMATCH',
        'The checkpoint must belong to this draft event.',
      );
    await audit(admin.userId, 'CREATE', 'round', result.rows[0]!.id, input.eventId, {
      sequence: input.sequence,
    });
    response.status(201).json({ data: result.rows[0] });
  }),
);

adminRouter.patch(
  '/admin/rounds/:roundId',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const roundId = uuid.parse(request.params.roundId);
    const input = z
      .object({
        clue: z.string().trim().min(2).max(1000).optional(),
        difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
        gameId: uuid.nullable().optional(),
      })
      .parse(request.body);

    const hasGameId = Object.prototype.hasOwnProperty.call(input, 'gameId');

    const result = await query<{ event_id: string; sequence: number }>(
      `UPDATE rounds r
       SET clue=COALESCE($2, clue),
           difficulty=COALESCE($3, difficulty),
           game_id=CASE WHEN $4::boolean THEN $5::uuid ELSE r.game_id END
       FROM events e
       WHERE r.id=$1 AND e.id=r.event_id AND e.status<>'FINISHED'
       RETURNING r.event_id, r.sequence`,
      [roundId, input.clue ?? null, input.difficulty ?? null, hasGameId, input.gameId ?? null],
    );
    if (!result.rows[0])
      throw new HttpError(404, 'ROUND_NOT_FOUND', 'Round not found or event is finished.');
    await audit(admin.userId, 'UPDATE', 'round', roundId, result.rows[0].event_id, input);
    response.json({ data: { id: roundId, ...input } });
  }),
);

adminRouter.post(
  '/admin/events/:eventId/round-games',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const eventId = uuid.parse(request.params.eventId);
    const input = z
      .object({
        setAllRandom: z.boolean().optional(),
        mappings: z
          .array(
            z.object({
              roundId: uuid,
              gameId: uuid.nullable().optional(),
              difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
            }),
          )
          .optional(),
      })
      .parse(request.body);

    await withTransaction(async (client) => {
      const event = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM events WHERE id=$1`,
        [eventId],
      );
      if (!event.rows[0]) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.');
      if (event.rows[0].status === 'FINISHED')
        throw new HttpError(409, 'EVENT_FINISHED', 'Cannot modify rounds for a finished event.');

      if (input.setAllRandom) {
        await client.query(`UPDATE rounds SET game_id=NULL WHERE event_id=$1`, [eventId]);
      } else if (input.mappings) {
        for (const mapping of input.mappings) {
          if (mapping.difficulty !== undefined && mapping.gameId !== undefined) {
            await client.query(
              `UPDATE rounds SET game_id=$2, difficulty=$3 WHERE id=$1 AND event_id=$4`,
              [mapping.roundId, mapping.gameId, mapping.difficulty, eventId],
            );
          } else if (mapping.difficulty !== undefined) {
            await client.query(
              `UPDATE rounds SET difficulty=$2 WHERE id=$1 AND event_id=$3`,
              [mapping.roundId, mapping.difficulty, eventId],
            );
          } else if (mapping.gameId !== undefined) {
            await client.query(
              `UPDATE rounds SET game_id=$2 WHERE id=$1 AND event_id=$3`,
              [mapping.roundId, mapping.gameId, eventId],
            );
          }
        }
      }
    });

    await audit(admin.userId, 'MAP_ROUND_GAMES', 'event', eventId, eventId, input);
    response.json({ data: { updated: true } });
  }),
);

adminRouter.post(
  '/admin/events/:eventId/round-difficulties',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const eventId = uuid.parse(request.params.eventId);
    const input = z
      .object({
        difficulties: z.array(
          z.object({
            roundId: uuid,
            difficulty: z.enum(['easy', 'medium', 'hard']),
          }),
        ),
      })
      .parse(request.body);

    await withTransaction(async (client) => {
      const event = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM events WHERE id=$1`,
        [eventId],
      );
      if (!event.rows[0]) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.');
      if (event.rows[0].status === 'FINISHED')
        throw new HttpError(409, 'EVENT_FINISHED', 'Cannot modify difficulties for a finished event.');

      for (const item of input.difficulties) {
        await client.query(
          `UPDATE rounds SET difficulty=$2 WHERE id=$1 AND event_id=$3`,
          [item.roundId, item.difficulty, eventId],
        );
      }
    });

    await audit(admin.userId, 'UPDATE_ROUND_DIFFICULTIES', 'event', eventId, eventId, {
      count: input.difficulties.length,
    });
    response.json({ data: { updated: true } });
  }),
);

adminRouter.post(
  '/admin/events/:eventId/clues',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const eventId = uuid.parse(request.params.eventId);
    const input = z
      .object({
        teamId: uuid,
        clues: z.array(
          z.object({
            roundId: uuid,
            clue: z.string().trim().min(1).max(1000),
          }),
        ),
      })
      .parse(request.body);

    await withTransaction(async (client) => {
      const event = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM events WHERE id=$1`,
        [eventId],
      );
      if (!event.rows[0]) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.');
      if (event.rows[0].status === 'FINISHED')
        throw new HttpError(409, 'EVENT_FINISHED', 'Cannot modify clues for a finished event.');

      const team = await client.query(
        `SELECT id FROM teams WHERE id=$1 AND event_id=$2 AND active`,
        [input.teamId, eventId],
      );
      if (!team.rows[0])
        throw new HttpError(404, 'TEAM_NOT_FOUND', 'Team not found in this event.');

      for (const item of input.clues) {
        const saved = await client.query(
          `INSERT INTO team_round_clues(team_id,round_id,clue,updated_at)
           SELECT $1,r.id,$3,now() FROM rounds r WHERE r.id=$2 AND r.event_id=$4
           ON CONFLICT (team_id,round_id) DO UPDATE SET clue=EXCLUDED.clue,updated_at=now()
           RETURNING round_id`,
          [input.teamId, item.roundId, item.clue, eventId],
        );
        if (!saved.rows[0])
          throw new HttpError(404, 'ROUND_NOT_FOUND', 'A round was not found in this event.');
      }
    });

    await audit(admin.userId, 'UPDATE_CLUES', 'event', eventId, eventId, {
      teamId: input.teamId,
      count: input.clues.length,
    });
    response.json({ data: { updated: true } });
  }),
);

adminRouter.get(
  '/admin/games',
  asyncRoute(async (request, response) => {
    requireAdmin(request);
    const result = await query(
      `SELECT g.id, g.code, g.name, COALESCE(g.description, '') AS description, g.enabled,
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', l.id,
           'difficulty', l.difficulty,
           'config', l.config,
           'maxAttempts', l.max_attempts,
           'cooldownSeconds', l.cooldown_seconds
         ) ORDER BY CASE l.difficulty WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END)
         FILTER (WHERE l.id IS NOT NULL), '[]'::jsonb) AS levels
       FROM games g
       LEFT JOIN game_levels l ON l.game_id = g.id AND l.enabled
       WHERE g.enabled
       GROUP BY g.id, g.code, g.name, g.description, g.enabled
       ORDER BY g.name`,
    );
    response.json({ data: result.rows });
  }),
);

adminRouter.post(
  '/admin/games',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const input = z
      .object({
        code: z.string().regex(/^[a-z-]+$/),
        name: z.string().min(2),
        enabled: z.boolean().default(true),
      })
      .parse(request.body);
    getGameModule(input.code);
    const result = await query<{ id: string }>(
      `INSERT INTO games(code,name,enabled) VALUES ($1,$2,$3) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,enabled=EXCLUDED.enabled RETURNING id`,
      [input.code, input.name, input.enabled],
    );
    await audit(admin.userId, 'UPSERT', 'game', result.rows[0]!.id, null, input);
    response.status(201).json({ data: result.rows[0] });
  }),
);

adminRouter.post(
  '/admin/games/:gameId/levels',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const gameId = uuid.parse(request.params.gameId);
    const input = z
      .object({
        difficulty: z.enum(['easy', 'medium', 'hard']),
        config: z.record(z.string(), z.unknown()),
        maxAttempts: z.number().int().min(1).max(20).default(5),
        cooldownSeconds: z.number().int().min(0).max(3600).default(10),
      })
      .parse(request.body);
    const result = await query<{ id: string }>(
      `INSERT INTO game_levels(game_id,difficulty,config,max_attempts,cooldown_seconds) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(game_id,difficulty) DO UPDATE SET config=EXCLUDED.config,max_attempts=EXCLUDED.max_attempts,cooldown_seconds=EXCLUDED.cooldown_seconds RETURNING id`,
      [gameId, input.difficulty, input.config, input.maxAttempts, input.cooldownSeconds],
    );
    await audit(admin.userId, 'UPSERT', 'game_level', result.rows[0]!.id, null, {
      gameId,
      ...input,
    });
    response.status(201).json({ data: result.rows[0] });
  }),
);

adminRouter.get(
  '/admin/audit-logs',
  asyncRoute(async (request, response) => {
    requireAdmin(request);
    const eventId = request.query.eventId ? uuid.parse(request.query.eventId) : null;
    const page = z.coerce.number().int().min(1).catch(1).parse(request.query.page);
    const limit = 50;
    const result = await query(
      `SELECT l.*,a.email AS admin_email FROM admin_audit_logs l JOIN admin_users a ON a.id=l.admin_id WHERE ($1::uuid IS NULL OR l.event_id=$1) ORDER BY l.created_at DESC LIMIT $2 OFFSET $3`,
      [eventId, limit, (page - 1) * limit],
    );
    response.json({ data: result.rows, meta: { page, limit } });
  }),
);

adminRouter.post(
  '/admin/demo-event',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    if (env.NODE_ENV === 'production')
      throw new HttpError(403, 'DISABLED', 'Demo provisioning is disabled in production.');
    const suffix = randomInt(1000, 9999);
    const slug = `demo-${suffix}`;
    const event = await query<{ id: string }>(
      `INSERT INTO events(name,slug) VALUES ($1,$2) RETURNING id`,
      [`Demo Hunt ${suffix}`, slug],
    );
    await audit(admin.userId, 'CREATE_DEMO', 'event', event.rows[0]!.id, event.rows[0]!.id, {});
    response.status(201).json({ data: { eventId: event.rows[0]!.id, slug } });
  }),
);

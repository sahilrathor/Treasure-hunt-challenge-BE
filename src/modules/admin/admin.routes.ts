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
    }>(
      `SELECT id,name,slug,status,COALESCE((settings->>'checkpointCount')::int,8) checkpoint_count
       FROM events ORDER BY (status='DRAFT') DESC,created_at DESC LIMIT 1`,
    );
    const current = event.rows[0];
    if (!current) {
      response.json({ data: { event: null, teams: [], checkpoints: [] } });
      return;
    }
    const [teams, checkpoints] = await Promise.all([
      query(
        `SELECT t.id,t.code,t.name,tp.status,tp.current_sequence,
         COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'memberCode',p.member_code,'displayName',p.display_name)
           ORDER BY p.member_code) FILTER (WHERE p.id IS NOT NULL),'[]'::jsonb) participants
         FROM teams t JOIN team_progress tp ON tp.team_id=t.id
         LEFT JOIN participants p ON p.team_id=t.id AND p.active
         WHERE t.event_id=$1 AND t.active
         GROUP BY t.id,tp.status,tp.current_sequence ORDER BY t.code`,
        [current.id],
      ),
      query(
        `SELECT c.id,c.label,r.sequence FROM checkpoints c
         JOIN rounds r ON r.checkpoint_id=c.id
         WHERE c.event_id=$1 AND c.active ORDER BY r.sequence`,
        [current.id],
      ),
    ]);
    response.json({
      data: { event: current, teams: teams.rows, checkpoints: checkpoints.rows },
    });
  }),
);

adminRouter.post(
  '/admin/simple/setup',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const { checkpointCount } = z
      .object({ checkpointCount: z.number().int().min(1).max(8) })
      .parse(request.body);
    const result = await withTransaction(async (client) => {
      const draft = await client.query<{ id: string; slug: string }>(
        `SELECT id,slug FROM events WHERE status='DRAFT' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      );
      let current = draft.rows[0];
      if (!current) {
        const slug = `college-fest-hunt-${Date.now()}`;
        const created = await client.query<{ id: string; slug: string }>(
          `INSERT INTO events(name,slug,settings)
           VALUES ('College Fest Hunt',$1,jsonb_build_object('checkpointCount',$2::int))
           RETURNING id,slug`,
          [slug, checkpointCount],
        );
        current = created.rows[0]!;
      } else {
        await client.query(
          `UPDATE events SET settings=settings || jsonb_build_object('checkpointCount',$2::int) WHERE id=$1`,
          [current.id, checkpointCount],
        );
        await client.query(`DELETE FROM rounds WHERE event_id=$1`, [current.id]);
        await client.query(`DELETE FROM checkpoints WHERE event_id=$1`, [current.id]);
      }

      const checkpoints: Array<{ id: string; label: string; sequence: number; scanUrl: string }> =
        [];
      for (let sequence = 1; sequence <= checkpointCount; sequence += 1) {
        const token = createToken(24);
        const checkpoint = await client.query<{ id: string; label: string }>(
          `INSERT INTO checkpoints(event_id,code,label,qr_token_hash)
           VALUES ($1,$2,$3,$4) RETURNING id,label`,
          [current.id, `CP-${sequence}`, `Checkpoint ${sequence}`, hashToken(token)],
        );
        const difficulty =
          sequence <= Math.ceil(checkpointCount / 3)
            ? 'easy'
            : sequence <= Math.ceil((checkpointCount * 2) / 3)
              ? 'medium'
              : 'hard';
        await client.query(
          `INSERT INTO rounds(event_id,checkpoint_id,sequence,clue,difficulty)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            current.id,
            checkpoint.rows[0]!.id,
            sequence,
            `Proceed to Checkpoint ${sequence}.`,
            difficulty,
          ],
        );
        checkpoints.push({
          id: checkpoint.rows[0]!.id,
          label: checkpoint.rows[0]!.label,
          sequence,
          scanUrl: `${env.FRONTEND_ORIGIN}/scan?token=${encodeURIComponent(token)}`,
        });
      }
      return { eventId: current.id, eventSlug: current.slug, checkpoints };
    });
    await audit(admin.userId, 'SIMPLE_SETUP', 'event', result.eventId, result.eventId, {
      checkpointCount,
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
        action: z.enum(['START', 'PAUSE', 'RESUME', 'FINISH']),
        reason: z.string().max(500).optional(),
      })
      .parse(request.body);
    await withTransaction(async (client) => {
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
          games: number;
          teams: number;
          invalid_teams: number;
        }>(
          `
        SELECT COALESCE((SELECT (settings->>'checkpointCount')::int FROM events WHERE id=$1),8) expected_rounds,
          (SELECT count(*)::int FROM rounds WHERE event_id=$1) rounds,
          (SELECT count(*)::int FROM games WHERE enabled) games,
          (SELECT count(*)::int FROM teams WHERE event_id=$1 AND active) teams,
          (SELECT count(*)::int FROM teams t WHERE t.event_id=$1 AND t.active AND (SELECT count(*) FROM participants p WHERE p.team_id=t.id AND p.active) NOT BETWEEN 3 AND 5) invalid_teams
      `,
          [eventId],
        );
        const ready = readiness.rows[0]!;
        if (
          ready.rounds !== ready.expected_rounds ||
          ready.games < ready.expected_rounds ||
          ready.teams < 1 ||
          ready.invalid_teams > 0
        )
          throw new HttpError(
            409,
            'EVENT_NOT_READY',
            'Finish checkpoint setup and add 3–5 members to every team.',
            ready,
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
      } else {
        if (!['RUNNING', 'PAUSED'].includes(event.rows[0].status))
          throw new HttpError(409, 'INVALID_EVENT_STATE', 'This event cannot finish.');
        await client.query(
          `UPDATE event_pauses SET ended_at=now() WHERE event_id=$1 AND ended_at IS NULL`,
          [eventId],
        );
        await client.query(`UPDATE events SET status='FINISHED',ends_at=now() WHERE id=$1`, [
          eventId,
        ]);
      }
    });
    await audit(admin.userId, action, 'event', eventId, eventId, { reason });
    response.json({ data: { eventId, action } });
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
      JOIN checkpoints c ON c.id = r.checkpoint_id
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

adminRouter.patch(
  '/admin/account/password',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const input = z
      .object({
        password: z.string().min(6).max(200),
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

adminRouter.post(
  '/admin/checkpoints',
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const input = checkpointSchema.parse(request.body);
    const token = createToken(24);
    const result = await query<{ id: string }>(
      `INSERT INTO checkpoints(event_id,code,label,qr_token_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.eventId, input.code, input.label, hashToken(token)],
    );
    await audit(admin.userId, 'CREATE', 'checkpoint', result.rows[0]!.id, input.eventId, {
      code: input.code,
    });
    response.status(201).json({
      data: {
        id: result.rows[0]!.id,
        qrToken: token,
        scanUrl: `${env.FRONTEND_ORIGIN}/scan?token=${encodeURIComponent(token)}`,
      },
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
        label: z.string().min(2).max(120).optional(),
        active: z.boolean().optional(),
        rotateToken: z.boolean().optional(),
      })
      .parse(request.body);
    const token = input.rotateToken ? createToken(24) : null;
    const result = await query<{ event_id: string }>(
      `UPDATE checkpoints c
       SET label=COALESCE($2,c.label),active=COALESCE($3,c.active),qr_token_hash=COALESCE($4,c.qr_token_hash)
       FROM events e WHERE c.id=$1 AND e.id=c.event_id AND e.status<>'FINISHED'
       RETURNING c.event_id`,
      [checkpointId, input.label ?? null, input.active ?? null, token ? hashToken(token) : null],
    );
    if (!result.rows[0])
      throw new HttpError(
        409,
        'CHECKPOINT_NOT_EDITABLE',
        'QR codes cannot be changed after the hunt is finished.',
      );
    await audit(admin.userId, 'UPDATE', 'checkpoint', checkpointId, result.rows[0].event_id, input);
    response.json({
      data: {
        id: checkpointId,
        ...(token
          ? {
              qrToken: token,
              scanUrl: `${env.FRONTEND_ORIGIN}/scan?token=${encodeURIComponent(token)}`,
            }
          : {}),
      },
    });
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
    const input = roundSchema.pick({ clue: true, difficulty: true }).partial().parse(request.body);
    const result = await query<{ event_id: string }>(
      `UPDATE rounds r SET clue=COALESCE($2,clue),difficulty=COALESCE($3,difficulty) FROM events e WHERE r.id=$1 AND e.id=r.event_id AND e.status='DRAFT' RETURNING r.event_id`,
      [roundId, input.clue ?? null, input.difficulty ?? null],
    );
    if (!result.rows[0])
      throw new HttpError(409, 'ROUND_NOT_EDITABLE', 'Only rounds in draft events can be edited.');
    await audit(admin.userId, 'UPDATE', 'round', roundId, result.rows[0].event_id, input);
    response.json({ data: { id: roundId } });
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

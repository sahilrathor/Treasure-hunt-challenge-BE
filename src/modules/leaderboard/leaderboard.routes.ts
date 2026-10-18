import { Router } from 'express';
import { z } from 'zod';

import { query } from '../../db/pool.js';
import { authenticate, requireAdmin } from '../../middleware/authenticate.js';
import { HttpError } from '../../utils/http-error.js';
import { asyncRoute } from '../../utils/route.js';

const uuid = z.string().uuid();

const leaderboardSql = `
  SELECT t.id,t.code,t.name,tp.status,tp.current_sequence,tp.started_at,tp.completed_at,
    COALESCE((SELECT count(*) FROM game_attempts x WHERE x.team_id=t.id AND x.status IN ('failed','expired')),0)::int failed_attempts,
    CASE WHEN tp.completed_at IS NULL OR tp.started_at IS NULL THEN NULL ELSE
      GREATEST(0,(extract(epoch FROM (tp.completed_at-tp.started_at))*1000)::bigint-
        COALESCE((SELECT sum((extract(epoch FROM (LEAST(COALESCE(p.ended_at,tp.completed_at),tp.completed_at)-GREATEST(p.started_at,tp.started_at)))*1000)::bigint)
          FROM event_pauses p WHERE p.event_id=t.event_id AND p.started_at<tp.completed_at AND COALESCE(p.ended_at,tp.completed_at)>tp.started_at),0))
    END adjusted_time_ms
  FROM teams t JOIN team_progress tp ON tp.team_id=t.id WHERE t.event_id=$1 AND t.active
  ORDER BY (tp.status='COMPLETED') DESC,adjusted_time_ms ASC NULLS LAST,failed_attempts ASC,tp.completed_at ASC NULLS LAST,t.code ASC
`;

export const leaderboardRouter = Router();

leaderboardRouter.get(
  '/leaderboard',
  authenticate,
  asyncRoute(async (request, response) => {
    requireAdmin(request);
    let eventId = request.query.eventId ? uuid.parse(request.query.eventId) : null;
    let event: { id: string; name: string; slug: string; status: string } | null = null;

    if (eventId) {
      const eventResult = await query<{ id: string; name: string; slug: string; status: string }>(
        `SELECT id, name, slug, status FROM events WHERE id = $1`,
        [eventId],
      );
      event = eventResult.rows[0] ?? null;
      if (!event) {
        throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.');
      }
    } else {
      const activeEvent = await query<{ id: string; name: string; slug: string; status: string }>(
        `SELECT id, name, slug, status FROM events
         ORDER BY CASE status WHEN 'RUNNING' THEN 1 WHEN 'PAUSED' THEN 2 WHEN 'FINISHED' THEN 3 ELSE 4 END, created_at DESC
         LIMIT 1`,
      );
      event = activeEvent.rows[0] ?? null;
      eventId = event?.id ?? null;
    }

    if (!eventId) {
      response.json({
        data: {
          event: null,
          completed: [],
          incomplete: [],
        },
      });
      return;
    }

    const result = await query(leaderboardSql, [eventId]);
    response.json({
      data: {
        event,
        completed: result.rows.filter((row) => row.status === 'COMPLETED'),
        incomplete: result.rows.filter((row) => row.status !== 'COMPLETED'),
      },
    });
  }),
);

leaderboardRouter.get(
  '/admin/results',
  authenticate,
  asyncRoute(async (request, response) => {
    requireAdmin(request);
    const eventId = uuid.parse(request.query.eventId);
    const page = z.coerce.number().int().min(1).catch(1).parse(request.query.page);
    const limit = 50;
    const result = await query(
      `SELECT x.id,t.code team_code,p.member_code,p.display_name,g.code game_code,r.sequence round,x.attempt_number,x.status,x.started_at,x.ended_at,x.duration_ms
    FROM game_attempts x JOIN teams t ON t.id=x.team_id JOIN participants p ON p.id=x.participant_id JOIN game_assignments a ON a.id=x.assignment_id JOIN games g ON g.id=a.game_id JOIN rounds r ON r.id=a.round_id
    WHERE t.event_id=$1 ORDER BY x.started_at DESC LIMIT $2 OFFSET $3`,
      [eventId, limit, (page - 1) * limit],
    );
    response.json({ data: result.rows, meta: { page, limit } });
  }),
);

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? 'NOT_PLAYED' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

leaderboardRouter.get(
  '/admin/results/export',
  authenticate,
  asyncRoute(async (request, response) => {
    requireAdmin(request);
    const eventId = uuid.parse(request.query.eventId);
    const result = await query(
      `SELECT t.code team_code,p.member_code,p.display_name,g.code game_code,r.sequence round,
    x.status,COALESCE(x.duration_ms::text,'NOT_PLAYED') duration_ms
    FROM teams t CROSS JOIN games g JOIN participants p ON p.team_id=t.id
    LEFT JOIN game_assignments a ON a.team_id=t.id AND a.game_id=g.id LEFT JOIN rounds r ON r.id=a.round_id
    LEFT JOIN game_attempts x ON x.assignment_id=a.id AND x.participant_id=p.id
    WHERE t.event_id=$1 ORDER BY t.code,p.member_code,r.sequence NULLS LAST,g.code,x.attempt_number`,
      [eventId],
    );
    const headers = [
      'team_code',
      'member_code',
      'display_name',
      'game_code',
      'round',
      'status',
      'duration_ms',
    ];
    const csv = [
      headers.join(','),
      ...result.rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
    ].join('\r\n');
    response
      .type('text/csv')
      .setHeader('Content-Disposition', 'attachment; filename="hunt-results.csv"')
      .send(csv);
  }),
);

leaderboardRouter.post(
  '/admin/assignments/:assignmentId/recover',
  authenticate,
  asyncRoute(async (request, response) => {
    const admin = requireAdmin(request);
    const assignmentId = uuid.parse(request.params.assignmentId);
    const { action, reason } = z
      .object({
        action: z.enum(['CANCEL_ACTIVE_ATTEMPT', 'REOPEN']),
        reason: z.string().min(5).max(500),
      })
      .parse(request.body);
    const assignment = await query<{ event_id: string }>(
      `SELECT t.event_id FROM game_assignments a JOIN teams t ON t.id=a.team_id WHERE a.id=$1`,
      [assignmentId],
    );
    if (!assignment.rows[0])
      throw new HttpError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found.');
    if (action === 'CANCEL_ACTIVE_ATTEMPT')
      await query(
        `UPDATE game_attempts SET status='cancelled',ended_at=now(),duration_ms=(extract(epoch FROM(now()-started_at))*1000)::bigint,result_metadata=$2 WHERE assignment_id=$1 AND status='in_progress'`,
        [assignmentId, { recoveryReason: reason }],
      );
    else
      await query(
        `UPDATE game_assignments SET status='ASSIGNED',passed_at=NULL WHERE id=$1 AND status='CANCELLED'`,
        [assignmentId],
      );
    await query(
      `INSERT INTO admin_audit_logs(admin_id,event_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,'assignment',$4,$5)`,
      [admin.userId, assignment.rows[0].event_id, action, assignmentId, { reason }],
    );
    response.json({ data: { assignmentId, action } });
  }),
);

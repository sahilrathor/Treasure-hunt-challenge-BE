import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';

import { query } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { authenticate, requireParticipant } from '../../middleware/authenticate.js';
import { hashToken } from '../../utils/crypto.js';
import { HttpError } from '../../utils/http-error.js';
import { asyncRoute } from '../../utils/route.js';
import { gameRegistry, getGameModule } from '../games/game-registry.js';
import type { Difficulty } from '../games/shared/game.types.js';

type TxClient = Parameters<Parameters<typeof withTransaction>[0]>[0];

const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(100);

interface AssignmentRow {
  id: string;
  team_id: string;
  round_id: string;
  game_id: string;
  game_enabled: boolean;
  round_mapped_game_id: string | null;
  status: string;
  game_code: string;
  game_name: string;
  game_description?: string;
  difficulty: Difficulty;
  config: Record<string, unknown>;
  public_challenge: Record<string, unknown>;
  secret_challenge: Record<string, unknown>;
  max_attempts: number;
  cooldown_seconds: number;
  round_sequence: number;
  checkpoint_label: string;
}

function assignmentResponse(
  row: AssignmentRow,
  attempts = 0,
  activeAttempt?: { id: string; started_at: string } | null,
) {
  return {
    id: row.id,
    status: row.status,
    gameCode: row.game_code,
    gameName: row.game_name,
    gameDescription: row.game_description ?? '',
    difficulty: row.difficulty,
    challenge: row.public_challenge,
    maxAttempts: row.max_attempts,
    attemptCount: attempts,
    cooldownSeconds: row.cooldown_seconds,
    round: row.round_sequence,
    checkpointLabel: row.checkpoint_label,
    activeAttempt: activeAttempt ?? null,
  };
}

const assignmentSelect = `
  SELECT a.id, a.team_id, a.round_id, a.game_id, g.enabled AS game_enabled, r.game_id AS round_mapped_game_id,
    a.status, g.code AS game_code, g.name AS game_name, COALESCE(g.description, '') AS game_description, r.difficulty, l.config,
    a.public_challenge, a.secret_challenge, l.max_attempts, l.cooldown_seconds,
    r.sequence AS round_sequence, c.label AS checkpoint_label
  FROM game_assignments a JOIN games g ON g.id=a.game_id JOIN game_levels l ON l.id=a.game_level_id
  JOIN rounds r ON r.id=a.round_id JOIN checkpoints c ON c.id=r.checkpoint_id
`;

async function selectGameForRound(
  client: TxClient,
  teamId: string,
  difficulty: Difficulty,
  roundMappedGameId: string | null | undefined,
  excludeRoundId?: string,
) {
  let selected: {
    game_id: string;
    game_level_id: string;
    game_code: string;
    game_name: string;
    config: Record<string, unknown>;
    max_attempts: number;
    cooldown_seconds: number;
  } | undefined;

  // 1. If round has a specific game mapped, check if team hasn't played it in any OTHER round
  if (roundMappedGameId) {
    const mapped = await client.query<{
      game_id: string;
      game_level_id: string;
      game_code: string;
      game_name: string;
      config: Record<string, unknown>;
      max_attempts: number;
      cooldown_seconds: number;
    }>(
      `
      SELECT g.id game_id, l.id game_level_id, g.code game_code, g.name game_name, l.config, l.max_attempts, l.cooldown_seconds
      FROM games g JOIN game_levels l ON l.game_id=g.id AND l.difficulty=$2 AND l.enabled
      WHERE g.id=$3 AND g.enabled
        AND NOT EXISTS (
          SELECT 1 FROM game_assignments a
          WHERE a.team_id=$1 AND a.game_id=g.id ${excludeRoundId ? 'AND a.round_id <> $4' : ''}
        )
    `,
      excludeRoundId
        ? [teamId, difficulty, roundMappedGameId, excludeRoundId]
        : [teamId, difficulty, roundMappedGameId],
    );
    if (mapped.rows[0]) {
      selected = mapped.rows[0];
    }
  }

  // 2. If no specific mapped game, or team already played that game in another round:
  // Pick randomly from enabled games that have NOT yet been played by this team in another round
  if (!selected) {
    const candidates = await client.query<{
      game_id: string;
      game_level_id: string;
      game_code: string;
      game_name: string;
      config: Record<string, unknown>;
      max_attempts: number;
      cooldown_seconds: number;
    }>(
      `
      SELECT g.id game_id, l.id game_level_id, g.code game_code, g.name game_name, l.config, l.max_attempts, l.cooldown_seconds
      FROM games g JOIN game_levels l ON l.game_id=g.id AND l.difficulty=$2 AND l.enabled
      WHERE g.enabled
        AND NOT EXISTS (
          SELECT 1 FROM game_assignments a
          WHERE a.team_id=$1 AND a.game_id=g.id ${excludeRoundId ? 'AND a.round_id <> $3' : ''}
        )
    `,
      excludeRoundId ? [teamId, difficulty, excludeRoundId] : [teamId, difficulty],
    );
    if (!candidates.rowCount || !candidates.rows[0]) {
      throw new HttpError(409, 'NO_GAMES_AVAILABLE', 'No unused game is available for this team.');
    }
    const picked = candidates.rows[randomInt(candidates.rows.length)];
    if (!picked) {
      throw new HttpError(409, 'NO_GAMES_AVAILABLE', 'No unused game is available for this team.');
    }
    selected = picked;
  }

  const challenge = getGameModule(selected.game_code).createChallenge(
    selected.config,
    difficulty,
  );

  return {
    selected,
    challenge,
  };
}

export const huntRouter = Router();
huntRouter.use(
  ['/teams', '/events', '/checkpoints', '/assignments', '/attempts', '/participants'],
  authenticate,
);

huntRouter.get(
  '/teams/me',
  asyncRoute(async (request, response) => {
    const participant = requireParticipant(request);
    const result = await query(
      `SELECT t.id,t.code,t.name,e.id AS event_id,e.name AS event_name,e.slug,e.status AS event_status,
    json_agg(json_build_object('id',p.id,'memberCode',p.member_code,'displayName',p.display_name) ORDER BY p.member_code) AS members
    FROM teams t JOIN events e ON e.id=t.event_id JOIN participants p ON p.team_id=t.id AND p.active
    WHERE t.id=$1 GROUP BY t.id,e.id`,
      [participant.teamId],
    );
    response.json({
      data: {
        ...result.rows[0],
        currentMember: {
          id: participant.userId,
          memberCode: participant.memberCode,
          displayName: participant.displayName,
        },
      },
    });
  }),
);

huntRouter.get(
  '/teams/me/progress',
  asyncRoute(async (request, response) => {
    const participant = requireParticipant(request);
    const result = await query(
      `SELECT tp.status,tp.current_sequence,tp.started_at,tp.completed_at,
    a.id AS assignment_id,a.status AS assignment_status,g.code AS game_code,g.name AS game_name,r.difficulty,
    (SELECT count(*)::int FROM game_attempts x WHERE x.assignment_id=a.id AND x.status<>'cancelled') AS attempt_count,
    l.max_attempts,l.cooldown_seconds,
    (SELECT max(ended_at) FROM game_attempts x WHERE x.assignment_id=a.id AND x.status IN ('failed','expired')) AS last_failed_at
    FROM team_progress tp LEFT JOIN rounds r ON r.event_id=$2 AND r.sequence=tp.current_sequence
    LEFT JOIN game_assignments a ON a.team_id=tp.team_id AND a.round_id=r.id
    LEFT JOIN games g ON g.id=a.game_id LEFT JOIN game_levels l ON l.id=a.game_level_id WHERE tp.team_id=$1`,
      [participant.teamId, participant.eventId],
    );
    response.json({ data: result.rows[0] });
  }),
);

huntRouter.post(
  '/events/:eventId/start',
  asyncRoute(async (request, response) => {
    const participant = requireParticipant(request);
    const eventId = uuid.parse(request.params.eventId);
    if (participant.eventId !== eventId)
      throw new HttpError(403, 'EVENT_FORBIDDEN', 'This event does not belong to your team.');
    const progress = await withTransaction(async (client) => {
      const result = await client.query<{
        event_status: string;
        progress_status: string;
        started_at: string | null;
      }>(
        `
      SELECT e.status event_status,tp.status progress_status,tp.started_at FROM team_progress tp
      JOIN teams t ON t.id=tp.team_id AND t.active JOIN events e ON e.id=t.event_id WHERE tp.team_id=$1 FOR UPDATE OF tp
    `,
        [participant.teamId],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(404, 'TEAM_NOT_FOUND', 'Team not found.');
      if (row.event_status !== 'RUNNING')
        throw new HttpError(409, 'EVENT_NOT_RUNNING', 'The event is not running.');
      if (row.progress_status === 'NOT_STARTED') {
        const updated = await client.query(
          `UPDATE team_progress SET status='IN_PROGRESS',started_at=now(),updated_at=now() WHERE team_id=$1 RETURNING status,current_sequence,started_at`,
          [participant.teamId],
        );
        return updated.rows[0];
      }
      return { status: row.progress_status, current_sequence: 1, started_at: row.started_at };
    });
    response.json({ data: progress });
  }),
);

huntRouter.post(
  '/checkpoints/scan',
  asyncRoute(async (request, response) => {
    const participant = requireParticipant(request);
    const { token } = z.object({ token: z.string().min(16).max(200) }).parse(request.body);
    const result = await withTransaction(async (client) => {
      const progress = await client.query<{
        current_sequence: number;
        progress_status: string;
        event_status: string;
      }>(
        `
      SELECT tp.current_sequence,tp.status progress_status,e.status event_status FROM team_progress tp
      JOIN teams t ON t.id=tp.team_id JOIN events e ON e.id=t.event_id WHERE tp.team_id=$1 FOR UPDATE OF tp
    `,
        [participant.teamId],
      );
      const state = progress.rows[0];
      if (!state || state.progress_status !== 'IN_PROGRESS')
        throw new HttpError(409, 'HUNT_NOT_ACTIVE', 'Start the hunt before scanning.');
      if (state.event_status !== 'RUNNING')
        throw new HttpError(409, 'EVENT_NOT_RUNNING', 'The event is paused or finished.');
      const round = await client.query<{
        id: string;
        sequence: number;
        difficulty: Difficulty;
        checkpoint_label: string;
        game_id: string | null;
      }>(
        `
      SELECT r.id,r.sequence,r.difficulty,c.label checkpoint_label,r.game_id FROM checkpoints c JOIN rounds r ON r.checkpoint_id=c.id
      WHERE c.event_id=$1 AND c.qr_token_hash=$2 AND c.active
    `,
        [participant.eventId, hashToken(token)],
      );
      const currentRound = round.rows[0];
      if (!currentRound)
        throw new HttpError(404, 'INVALID_QR', 'This checkpoint QR is invalid or disabled.');
      if (currentRound.sequence !== state.current_sequence)
        throw new HttpError(
          409,
          'CHECKPOINT_NOT_CURRENT',
          'This checkpoint is not available for your current round.',
        );
      const existing = await client.query<AssignmentRow>(
        `${assignmentSelect} WHERE a.team_id=$1 AND a.round_id=$2`,
        [participant.teamId, currentRound.id],
      );
      if (existing.rows[0]) {
        const existingRow = existing.rows[0];
        const isGameUnavailable = !existingRow.game_enabled || !gameRegistry.has(existingRow.game_code);
        const isMappingMismatched = Boolean(
          currentRound.game_id && currentRound.game_id !== existingRow.game_id,
        );

        if (existingRow.status !== 'PASSED' && (isGameUnavailable || isMappingMismatched)) {
          const { selected, challenge } = await selectGameForRound(
            client,
            participant.teamId,
            currentRound.difficulty,
            currentRound.game_id,
            currentRound.id,
          );

          await client.query(
            `UPDATE game_attempts SET status='cancelled', ended_at=now() WHERE assignment_id=$1 AND status='in_progress'`,
            [existingRow.id],
          );

          await client.query(
            `UPDATE game_assignments
             SET game_id=$2, game_level_id=$3, public_challenge=$4, secret_challenge=$5, status='ASSIGNED', assigned_at=now()
             WHERE id=$1`,
            [
              existingRow.id,
              selected.game_id,
              selected.game_level_id,
              challenge.publicData,
              challenge.secretData,
            ],
          );

          const updated = await client.query<AssignmentRow>(
            `${assignmentSelect} WHERE a.id=$1`,
            [existingRow.id],
          );
          if (!updated.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Assignment not found.');
          return assignmentResponse(updated.rows[0], 0, null);
        }

        const active = await client.query<{ id: string; started_at: string }>(
          `SELECT id, started_at FROM game_attempts
           WHERE assignment_id=$1 AND status='in_progress' AND started_at >= now() - interval '5 minutes'
           ORDER BY started_at DESC LIMIT 1`,
          [existingRow.id],
        );
        return assignmentResponse(
          existingRow,
          Number(
            (
              await client.query(
                `SELECT count(*)::int count FROM game_attempts WHERE assignment_id=$1 AND status<>'cancelled'`,
                [existingRow.id],
              )
            ).rows[0]?.count ?? 0,
          ),
          active.rows[0] ?? null,
        );
      }

      const { selected, challenge } = await selectGameForRound(
        client,
        participant.teamId,
        currentRound.difficulty,
        currentRound.game_id,
      );

      const inserted = await client.query<{ id: string; status: string }>(
        `INSERT INTO game_assignments(team_id,round_id,game_id,game_level_id,public_challenge,secret_challenge) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,status`,
        [
          participant.teamId,
          currentRound.id,
          selected.game_id,
          selected.game_level_id,
          challenge.publicData,
          challenge.secretData,
        ],
      );
      return assignmentResponse(
        {
          ...selected,
          ...inserted.rows[0]!,
          game_enabled: true,
          round_mapped_game_id: currentRound.game_id,
          team_id: participant.teamId,
          round_id: currentRound.id,
          difficulty: currentRound.difficulty,
          public_challenge: challenge.publicData,
          secret_challenge: challenge.secretData,
          round_sequence: currentRound.sequence,
          checkpoint_label: currentRound.checkpoint_label,
        },
        0,
      );
    });
    response.json({ data: result });
  }),
);

huntRouter.get(
  '/assignments/:assignmentId',
  asyncRoute(async (request, response) => {
    const participant = requireParticipant(request);
    const assignmentId = uuid.parse(request.params.assignmentId);
    let result = await query<AssignmentRow>(
      `${assignmentSelect}
       JOIN team_progress tp ON tp.team_id=a.team_id
       WHERE a.id=$1 AND a.team_id=$2 AND a.status='ASSIGNED'
         AND tp.status='IN_PROGRESS' AND r.sequence=tp.current_sequence`,
      [assignmentId, participant.teamId],
    );
    if (!result.rows[0])
      throw new HttpError(
        404,
        'CURRENT_GAME_NOT_FOUND',
        'Scan the QR at your current checkpoint to unlock the game.',
      );

    let row = result.rows[0];
    const isGameUnavailable = !row.game_enabled || !gameRegistry.has(row.game_code);
    if (row.status !== 'PASSED' && isGameUnavailable) {
      await withTransaction(async (client) => {
        const roundResult = await client.query<{ id: string; difficulty: Difficulty; game_id: string | null }>(
          `SELECT id, difficulty, game_id FROM rounds WHERE id=$1`,
          [row.round_id],
        );
        if (roundResult.rows[0]) {
          const { selected, challenge } = await selectGameForRound(
            client,
            participant.teamId,
            roundResult.rows[0].difficulty,
            roundResult.rows[0].game_id,
            row.round_id,
          );
          await client.query(
            `UPDATE game_attempts SET status='cancelled', ended_at=now() WHERE assignment_id=$1 AND status='in_progress'`,
            [assignmentId],
          );
          await client.query(
            `UPDATE game_assignments
             SET game_id=$2, game_level_id=$3, public_challenge=$4, secret_challenge=$5, status='ASSIGNED', assigned_at=now()
             WHERE id=$1`,
            [
              assignmentId,
              selected.game_id,
              selected.game_level_id,
              challenge.publicData,
              challenge.secretData,
            ],
          );
        }
      });
      result = await query<AssignmentRow>(
        `${assignmentSelect} WHERE a.id=$1`,
        [assignmentId],
      );
      row = result.rows[0]!;
    }

    const attempts = await query<{ count: number }>(
      `SELECT count(*)::int count FROM game_attempts WHERE assignment_id=$1 AND status<>'cancelled'`,
      [assignmentId],
    );
    const active = await query<{ id: string; started_at: string }>(
      `SELECT id, started_at FROM game_attempts
       WHERE assignment_id=$1 AND status='in_progress' AND started_at >= now() - interval '5 minutes'
       ORDER BY started_at DESC LIMIT 1`,
      [assignmentId],
    );
    response.json({
      data: assignmentResponse(
        row,
        attempts.rows[0]?.count ?? 0,
        active.rows[0] ?? null,
      ),
    });
  }),
);

huntRouter.post(
  '/assignments/:assignmentId/reload',
  asyncRoute(async (request, response) => {
    const participant = requireParticipant(request);
    const assignmentId = uuid.parse(request.params.assignmentId);

    const updated = await withTransaction(async (client) => {
      const assignment = await client.query<AssignmentRow>(
        `${assignmentSelect}
         JOIN team_progress tp ON tp.team_id=a.team_id
         WHERE a.id=$1 AND a.team_id=$2 AND a.status='ASSIGNED'
           AND tp.status='IN_PROGRESS' AND r.sequence=tp.current_sequence`,
        [assignmentId, participant.teamId],
      );
      if (!assignment.rows[0]) {
        throw new HttpError(404, 'ASSIGNMENT_NOT_FOUND', 'Active assignment not found for current round.');
      }
      const row = assignment.rows[0];

      const roundResult = await client.query<{ id: string; difficulty: Difficulty; game_id: string | null }>(
        `SELECT id, difficulty, game_id FROM rounds WHERE id=$1`,
        [row.round_id],
      );
      if (!roundResult.rows[0]) {
        throw new HttpError(404, 'ROUND_NOT_FOUND', 'Round not found.');
      }

      const { selected, challenge } = await selectGameForRound(
        client,
        participant.teamId,
        roundResult.rows[0].difficulty,
        roundResult.rows[0].game_id,
        row.round_id,
      );

      // Cancel any in-progress attempt on old game
      await client.query(
        `UPDATE game_attempts SET status='cancelled', ended_at=now() WHERE assignment_id=$1 AND status='in_progress'`,
        [assignmentId],
      );

      // Update assignment with new game
      await client.query(
        `UPDATE game_assignments
         SET game_id=$2, game_level_id=$3, public_challenge=$4, secret_challenge=$5, status='ASSIGNED', assigned_at=now()
         WHERE id=$1`,
        [
          assignmentId,
          selected.game_id,
          selected.game_level_id,
          challenge.publicData,
          challenge.secretData,
        ],
      );

      const refreshed = await client.query<AssignmentRow>(
        `${assignmentSelect} WHERE a.id=$1`,
        [assignmentId],
      );
      const attempts = await client.query<{ count: number }>(
        `SELECT count(*) FILTER(WHERE status<>'cancelled')::int count
         FROM game_attempts WHERE assignment_id=$1`,
        [assignmentId],
      );
      return { assignment: refreshed.rows[0]!, attemptCount: attempts.rows[0]?.count ?? 0 };
    });

    response.json({
      data: assignmentResponse(updated.assignment, updated.attemptCount, null),
    });
  }),
);

huntRouter.post(
  '/assignments/:assignmentId/attempts',
  asyncRoute(async (request, response) => {
    const participant = requireParticipant(request);
    const assignmentId = uuid.parse(request.params.assignmentId);
    const key = idempotencyKey.parse(request.headers['idempotency-key']);
    const attempt = await withTransaction(async (client) => {
      const assignment = await client.query<{
        status: string;
        max_attempts: number;
        cooldown_seconds: number;
        progress_status: string;
        event_status: string;
        is_current_round: boolean;
      }>(
        `SELECT a.status,l.max_attempts,l.cooldown_seconds,tp.status progress_status,e.status event_status,
           (r.sequence=tp.current_sequence) is_current_round
         FROM game_assignments a JOIN game_levels l ON l.id=a.game_level_id
         JOIN rounds r ON r.id=a.round_id JOIN team_progress tp ON tp.team_id=a.team_id
         JOIN teams t ON t.id=a.team_id JOIN events e ON e.id=t.event_id
         WHERE a.id=$1 AND a.team_id=$2 FOR UPDATE OF a,tp`,
        [assignmentId, participant.teamId],
      );
      const row = assignment.rows[0];
      if (!row) throw new HttpError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found.');
      if (
        row.progress_status !== 'IN_PROGRESS' ||
        row.event_status !== 'RUNNING' ||
        !row.is_current_round
      )
        throw new HttpError(
          409,
          'CURRENT_QR_REQUIRED',
          'Scan the QR at your current checkpoint before starting the game.',
        );
      if (row.status !== 'ASSIGNED')
        throw new HttpError(
          409,
          'ASSIGNMENT_CLOSED',
          'This assignment no longer accepts attempts.',
        );
      const repeated = await client.query(
        `SELECT id,status,started_at,attempt_number FROM game_attempts WHERE participant_id=$1 AND start_idempotency_key=$2`,
        [participant.userId, key],
      );
      if (repeated.rows[0]) return repeated.rows[0];
      await client.query(
        `UPDATE game_attempts SET status='expired',ended_at=now(),duration_ms=(extract(epoch FROM(now()-started_at))*1000)::bigint,result_metadata='{"reason":"time_limit"}'::jsonb
      WHERE assignment_id=$1 AND status='in_progress' AND started_at < now() - interval '5 minutes'`,
        [assignmentId],
      );
      const history = await client.query<{
        count: number;
        last_ended_at: string | null;
        active: number;
        last_attempt_number: number;
      }>(
        `SELECT count(*) FILTER(WHERE status<>'cancelled')::int count,
           max(ended_at) FILTER(WHERE status IN ('failed','expired')) last_ended_at,
           count(*) FILTER(WHERE status='in_progress')::int active,
           COALESCE(max(attempt_number),0)::int last_attempt_number
         FROM game_attempts WHERE assignment_id=$1`,
        [assignmentId],
      );
      const h = history.rows[0]!;
      if (h.active > 0)
        throw new HttpError(
          409,
          'ATTEMPT_IN_PROGRESS',
          'Another team member already has an active attempt.',
        );
      if (h.count >= row.max_attempts)
        throw new HttpError(409, 'ATTEMPT_LIMIT_REACHED', 'No attempts remain.');
      if (
        h.last_ended_at &&
        Date.now() - new Date(h.last_ended_at).getTime() < row.cooldown_seconds * 1000
      ) {
        const retryAt = new Date(
          new Date(h.last_ended_at).getTime() + row.cooldown_seconds * 1000,
        ).toISOString();
        throw new HttpError(429, 'COOLDOWN_ACTIVE', 'Wait before starting another attempt.', {
          retryAt,
        });
      }
      const inserted = await client.query(
        `INSERT INTO game_attempts(assignment_id,team_id,participant_id,attempt_number,start_idempotency_key) VALUES ($1,$2,$3,$4,$5) RETURNING id,status,started_at,attempt_number`,
        [assignmentId, participant.teamId, participant.userId, h.last_attempt_number + 1, key],
      );
      return inserted.rows[0];
    });
    response.status(201).json({ data: attempt });
  }),
);

huntRouter.post(
  '/attempts/:attemptId/submit',
  asyncRoute(async (request, response) => {
    const participant = requireParticipant(request);
    const attemptId = uuid.parse(request.params.attemptId);
    const key = idempotencyKey.parse(request.headers['idempotency-key']);
    const submission = z.object({ result: z.unknown() }).parse(request.body);
    const outcome = await withTransaction(async (client) => {
      const found = await client.query<
        AssignmentRow & {
          attempt_id: string;
          attempt_status: string;
          started_at: string;
          participant_id: string;
          team_id: string;
          result_metadata: Record<string, unknown> | null;
          submit_idempotency_key: string | null;
          duration_ms: number | null;
          checkpoint_count: number;
        }
      >(
        `
      SELECT a.id,a.status,g.code game_code,g.name game_name,r.difficulty,l.config,a.public_challenge,a.secret_challenge,l.max_attempts,l.cooldown_seconds,r.sequence round_sequence,c.label checkpoint_label,
        x.id attempt_id,x.status attempt_status,x.started_at,x.participant_id,x.team_id,x.result_metadata,x.submit_idempotency_key,x.duration_ms,
        COALESCE((e.settings->>'checkpointCount')::int,8) checkpoint_count
      FROM game_attempts x JOIN game_assignments a ON a.id=x.assignment_id JOIN games g ON g.id=a.game_id JOIN game_levels l ON l.id=a.game_level_id JOIN rounds r ON r.id=a.round_id JOIN checkpoints c ON c.id=r.checkpoint_id JOIN teams t ON t.id=x.team_id JOIN events e ON e.id=t.event_id
      WHERE x.id=$1 FOR UPDATE OF x,a
    `,
        [attemptId],
      );
      const row = found.rows[0];
      if (!row || row.team_id !== participant.teamId)
        throw new HttpError(404, 'ATTEMPT_NOT_FOUND', 'Attempt not found.');
      if (row.participant_id !== participant.userId)
        throw new HttpError(
          403,
          'ATTEMPT_OWNER_REQUIRED',
          'Only the member who started this attempt may submit it.',
        );
      if (row.attempt_status !== 'in_progress')
        return {
          status: row.attempt_status,
          durationMs: Number(row.duration_ms ?? 0),
          metadata: row.result_metadata,
          clueUnlocked: row.attempt_status === 'passed',
        };
      const durationMs = Math.max(0, Date.now() - new Date(row.started_at).getTime());
      const configuredLimit =
        typeof row.config.timeLimitSeconds === 'number' ? row.config.timeLimitSeconds : 300;
      let status: 'passed' | 'failed' | 'expired';
      let metadata: Record<string, unknown>;
      if (durationMs > configuredLimit * 1000) {
        status = 'expired';
        metadata = { reason: 'time_limit' };
      } else {
        const validated = getGameModule(row.game_code).validate(
          row.config,
          row.public_challenge,
          row.secret_challenge,
          submission.result,
        );
        status = validated.passed ? 'passed' : 'failed';
        metadata = validated.metadata;
      }
      await client.query(
        `UPDATE game_attempts SET status=$2,ended_at=now(),duration_ms=$3,result_metadata=$4,submit_idempotency_key=$5 WHERE id=$1`,
        [attemptId, status, durationMs, metadata, key],
      );
      let clueUnlocked = false;
      if (status === 'passed' && row.status === 'ASSIGNED') {
        await client.query(
          `UPDATE game_assignments SET status='PASSED',passed_at=now() WHERE id=$1`,
          [row.id],
        );
        const progress = await client.query<{ current_sequence: number }>(
          `SELECT current_sequence FROM team_progress WHERE team_id=$1 FOR UPDATE`,
          [participant.teamId],
        );
        if (progress.rows[0]?.current_sequence === row.round_sequence) {
          if (row.round_sequence === row.checkpoint_count)
            await client.query(
              `UPDATE team_progress SET status='COMPLETED',current_sequence=$2,completed_at=now(),updated_at=now() WHERE team_id=$1`,
              [participant.teamId, row.checkpoint_count + 1],
            );
          else {
            await client.query(
              `UPDATE team_progress SET current_sequence=current_sequence+1,updated_at=now() WHERE team_id=$1`,
              [participant.teamId],
            );
            clueUnlocked = true;
          }
        }
      }
      return {
        status,
        durationMs,
        metadata,
        clueUnlocked,
        retryAt:
          status === 'failed' || status === 'expired'
            ? new Date(Date.now() + row.cooldown_seconds * 1000).toISOString()
            : null,
      };
    });
    response.json({ data: outcome });
  }),
);

huntRouter.get(
  '/teams/me/clue',
  asyncRoute(async (request, response) => {
    const participant = requireParticipant(request);
    const result = await query(
      `SELECT tp.status,tp.current_sequence,r.clue,r.sequence FROM team_progress tp LEFT JOIN rounds r ON r.event_id=$2 AND r.sequence=tp.current_sequence WHERE tp.team_id=$1`,
      [participant.teamId, participant.eventId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, 'PROGRESS_NOT_FOUND', 'Progress not found.');
    if (row.status === 'NOT_STARTED')
      throw new HttpError(409, 'HUNT_NOT_STARTED', 'Start the hunt to unlock the first clue.');
    response.json({
      data:
        row.status === 'COMPLETED'
          ? { status: 'COMPLETED', clue: null }
          : { status: row.status, round: row.sequence, clue: row.clue },
    });
  }),
);

huntRouter.get(
  '/participants/me/history',
  asyncRoute(async (request, response) => {
    const participant = requireParticipant(request);
    const result = await query(
      `SELECT x.id,x.status,x.attempt_number,x.started_at,x.ended_at,x.duration_ms,g.code game_code,g.name game_name,r.sequence round
    FROM game_attempts x JOIN game_assignments a ON a.id=x.assignment_id JOIN games g ON g.id=a.game_id JOIN rounds r ON r.id=a.round_id
    WHERE x.participant_id=$1 ORDER BY x.started_at DESC`,
      [participant.userId],
    );
    response.json({ data: result.rows });
  }),
);

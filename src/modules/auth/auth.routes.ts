import argon2 from 'argon2';
import { Router } from 'express';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { query } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { authenticate, readSessionToken } from '../../middleware/authenticate.js';
import { createToken, hashToken } from '../../utils/crypto.js';
import { HttpError } from '../../utils/http-error.js';
import { asyncRoute } from '../../utils/route.js';

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
  qrToken: z.string().min(16).max(200).optional(),
  force: z.boolean().optional(),
});

const cookieName = 'hunt_session';
const cookieSecurity = env.NODE_ENV === 'production' ? 'SameSite=None; Secure' : 'SameSite=Lax';
const cookieOptions = (maxAge = env.SESSION_HOURS * 3600) =>
  `HttpOnly; Path=/api/v1; ${cookieSecurity}; Max-Age=${maxAge}`;

async function createSession(owner: {
  participantId?: string;
  adminId?: string;
  scanTokenHash?: string;
}) {
  const token = createToken();
  await query(
    `INSERT INTO sessions(token_hash, participant_id, admin_id, scan_token_hash, expires_at) VALUES ($1,$2,$3,$4,now() + ($5 || ' hours')::interval)`,
    [
      hashToken(token),
      owner.participantId ?? null,
      owner.adminId ?? null,
      owner.scanTokenHash ?? null,
      env.SESSION_HOURS,
    ],
  );
  return token;
}

export const authRouter = Router();

authRouter.post(
  '/auth/login',
  asyncRoute(async (request, response) => {
    const input = loginSchema.parse(request.body);
    const admin = await query<{ id: string; password_hash: string }>(
      `SELECT id, password_hash FROM admin_users WHERE email = $1 AND active`,
      [input.identifier],
    );
    let token: string;
    if (admin.rows[0] && (await argon2.verify(admin.rows[0].password_hash, input.password))) {
      token = await createSession({ adminId: admin.rows[0].id });
    } else {
      const participant = await query<{ id: string; team_id: string; password_hash: string }>(
        `
      SELECT p.id, p.team_id, p.password_hash FROM participants p JOIN events e ON e.id = p.event_id
      WHERE p.member_code = $1 AND p.active AND e.status IN ('RUNNING','PAUSED','DRAFT')
      ORDER BY CASE e.status WHEN 'RUNNING' THEN 1 WHEN 'PAUSED' THEN 2 ELSE 3 END,e.created_at DESC
      LIMIT 1
    `,
        [input.identifier],
      );
      if (
        !participant.rows[0] ||
        !(await argon2.verify(participant.rows[0].password_hash, input.password))
      ) {
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
      }
      const selected = participant.rows[0];
      token = await withTransaction(async (client) => {
        await client.query(`SELECT id FROM teams WHERE id=$1 FOR UPDATE`, [selected.team_id]);
        const active = await client.query<{
          participant_id: string;
          display_name: string;
          member_code: string;
          created_at: string;
        }>(
          `SELECT s.participant_id, p.display_name, p.member_code, s.created_at
           FROM sessions s JOIN participants p ON p.id=s.participant_id
           WHERE p.team_id=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
           ORDER BY (s.participant_id<>$2) DESC, s.created_at DESC LIMIT 1`,
          [selected.team_id, selected.id],
        );
        if (active.rows[0] && active.rows[0].participant_id !== selected.id) {
          if (!input.force) {
            throw new HttpError(
              409,
              'TEAM_ALREADY_LOGGED_IN',
              'Another player from your team is already logged in.',
              {
                activePlayer: {
                  participantId: active.rows[0].participant_id,
                  displayName: active.rows[0].display_name,
                  memberCode: active.rows[0].member_code,
                  loggedInAt: active.rows[0].created_at,
                },
              },
            );
          }
          await client.query(
            `UPDATE sessions SET revoked_at=now()
             FROM participants p
             WHERE sessions.participant_id=p.id
               AND p.team_id=$1
               AND sessions.revoked_at IS NULL
               AND sessions.expires_at>now()`,
            [selected.team_id],
          );
        }
        await client.query(
          `UPDATE sessions SET revoked_at=now()
           WHERE participant_id=$1 AND revoked_at IS NULL AND expires_at>now()`,
          [selected.id],
        );
        let scanTokenHash: string | undefined;
        if (input.qrToken) {
          scanTokenHash = hashToken(input.qrToken);
          const qr = await client.query(
            `SELECT c.id FROM checkpoints c
             WHERE c.active AND (c.qr_token_hash=$1 OR c.qr_token=$2 OR EXISTS (
               SELECT 1 FROM team_checkpoint_qrs q WHERE q.checkpoint_id=c.id AND q.qr_token_hash=$1
             ))`,
            [scanTokenHash, input.qrToken],
          );
          if (!qr.rows[0]) {
            throw new HttpError(
              403,
              'INVALID_TEAM_QR',
              'This QR code is invalid or disabled.',
            );
          }
        }
        const sessionToken = createToken();
        await client.query(
          `INSERT INTO sessions(token_hash,participant_id,scan_token_hash,expires_at)
           VALUES ($1,$2,$3,now() + ($4 || ' hours')::interval)`,
          [hashToken(sessionToken), selected.id, scanTokenHash ?? null, env.SESSION_HOURS],
        );
        return sessionToken;
      });
    }
    response.setHeader(
      'Set-Cookie',
      `${cookieName}=${encodeURIComponent(token)}; ${cookieOptions()}`,
    );
    response.status(200).json({ data: { authenticated: true } });
  }),
);

authRouter.post(
  '/auth/logout',
  authenticate,
  asyncRoute(async (request, response) => {
    await query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [request.auth!.sessionId]);
    response.setHeader('Set-Cookie', `${cookieName}=; ${cookieOptions(0)}`);
    response.status(204).end();
  }),
);

authRouter.post(
  '/auth/refresh',
  authenticate,
  asyncRoute(async (request, response) => {
    const oldToken = readSessionToken(request);
    if (!oldToken) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
    await query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [request.auth!.sessionId]);
    const token = await createSession(
      request.auth!.role === 'PARTICIPANT'
        ? { participantId: request.auth!.userId }
        : { adminId: request.auth!.userId },
    );
    response.setHeader(
      'Set-Cookie',
      `${cookieName}=${encodeURIComponent(token)}; ${cookieOptions()}`,
    );
    response.json({ data: { refreshed: true } });
  }),
);

authRouter.get('/me', authenticate, (request, response) => {
  const identity = request.auth!;
  response.json({
    data: {
      sessionId: identity.sessionId,
      userId: identity.userId,
      role: identity.role,
      displayName: identity.displayName,
      username: identity.username,
      eventId: identity.eventId,
      teamId: identity.teamId,
      memberCode: identity.memberCode,
    },
  });
});

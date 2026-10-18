import argon2 from 'argon2';
import { Router } from 'express';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { query } from '../../db/pool.js';
import { authenticate, readSessionToken } from '../../middleware/authenticate.js';
import { createToken, hashToken } from '../../utils/crypto.js';
import { HttpError } from '../../utils/http-error.js';
import { asyncRoute } from '../../utils/route.js';

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
});

const cookieName = 'hunt_session';
const cookieOptions = () =>
  `HttpOnly; Path=/api/v1; SameSite=Lax; Max-Age=${env.SESSION_HOURS * 3600}${env.NODE_ENV === 'production' ? '; Secure' : ''}`;

async function createSession(owner: { participantId?: string; adminId?: string }) {
  const token = createToken();
  await query(
    `INSERT INTO sessions(token_hash, participant_id, admin_id, expires_at) VALUES ($1,$2,$3,now() + ($4 || ' hours')::interval)`,
    [hashToken(token), owner.participantId ?? null, owner.adminId ?? null, env.SESSION_HOURS],
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
      const participant = await query<{ id: string; password_hash: string }>(
        `
      SELECT p.id, p.password_hash FROM participants p JOIN events e ON e.id = p.event_id
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
      token = await createSession({ participantId: participant.rows[0].id });
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
    response.setHeader(
      'Set-Cookie',
      `${cookieName}=; HttpOnly; Path=/api/v1; SameSite=Lax; Max-Age=0`,
    );
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
  response.json({ data: request.auth });
});

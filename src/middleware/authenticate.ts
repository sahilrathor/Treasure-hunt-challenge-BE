import type { Request, RequestHandler } from 'express';

import { query } from '../db/pool.js';
import { hashToken } from '../utils/crypto.js';
import { HttpError } from '../utils/http-error.js';

export interface AuthIdentity {
  sessionId: string;
  userId: string;
  role: 'PARTICIPANT' | 'ADMIN' | 'SUPER_ADMIN';
  displayName: string;
  username: string | null;
  eventId: string | null;
  teamId: string | null;
  memberCode: string | null;
  scanTokenHash: string | null;
}

declare global {
  // Express request augmentation requires declaration merging.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthIdentity;
    }
  }
}

export function readSessionToken(request: Request) {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  const cookies = request.headers.cookie?.split(';').map((value) => value.trim()) ?? [];
  const cookie = cookies.find((value) => value.startsWith('hunt_session='));
  return cookie ? decodeURIComponent(cookie.slice('hunt_session='.length)) : undefined;
}

export const authenticate: RequestHandler = async (request, _response, next) => {
  try {
    const token = readSessionToken(request);
    if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
    const result = await query<{
      session_id: string;
      user_id: string;
      role: AuthIdentity['role'];
      display_name: string;
      username: string | null;
      event_id: string | null;
      team_id: string | null;
      member_code: string | null;
      scan_token_hash: string | null;
    }>(
      `
      SELECT s.id AS session_id,
        COALESCE(p.id, a.id) AS user_id,
        CASE WHEN p.id IS NOT NULL THEN 'PARTICIPANT' ELSE a.role END AS role,
        COALESCE(p.display_name, a.display_name) AS display_name,
        a.email AS username,
        p.event_id, p.team_id, p.member_code, s.scan_token_hash
      FROM sessions s
      LEFT JOIN participants p ON p.id = s.participant_id AND p.active
      LEFT JOIN admin_users a ON a.id = s.admin_id AND a.active
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND (p.id IS NOT NULL OR a.id IS NOT NULL)
    `,
      [hashToken(token)],
    );
    const identity = result.rows[0];
    if (!identity)
      throw new HttpError(401, 'SESSION_EXPIRED', 'The session is invalid or expired.');
    request.auth = {
      sessionId: identity.session_id,
      userId: identity.user_id,
      role: identity.role,
      displayName: identity.display_name,
      username: identity.username,
      eventId: identity.event_id,
      teamId: identity.team_id,
      memberCode: identity.member_code,
      scanTokenHash: identity.scan_token_hash,
    };
    next();
  } catch (error) {
    next(error);
  }
};

export function requireRole(...roles: AuthIdentity['role'][]): RequestHandler {
  return (request, _response, next) => {
    if (!request.auth || !roles.includes(request.auth.role)) {
      next(new HttpError(403, 'FORBIDDEN', 'You do not have access to this resource.'));
      return;
    }
    next();
  };
}

export function requireParticipant(
  request: Request,
): AuthIdentity & { teamId: string; eventId: string } {
  const identity = request.auth;
  if (!identity || identity.role !== 'PARTICIPANT' || !identity.teamId || !identity.eventId) {
    throw new HttpError(403, 'PARTICIPANT_REQUIRED', 'A participant account is required.');
  }
  return identity as AuthIdentity & { teamId: string; eventId: string };
}

export function requireAdmin(request: Request) {
  const identity = request.auth;
  if (!identity || (identity.role !== 'ADMIN' && identity.role !== 'SUPER_ADMIN')) {
    throw new HttpError(403, 'ADMIN_REQUIRED', 'An administrator account is required.');
  }
  return identity;
}

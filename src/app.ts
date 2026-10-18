import cors from 'cors';
import express, { type RequestHandler } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import rateLimit from 'express-rate-limit';

import { createLogger } from './config/logger.js';
import { query } from './db/pool.js';
import { errorHandler } from './middleware/error-handler.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { huntRouter } from './modules/hunt/hunt.routes.js';
import { leaderboardRouter } from './modules/leaderboard/leaderboard.routes.js';
import { HttpError } from './utils/http-error.js';

export interface AppOptions {
  allowedOrigin?: string;
  logLevel?: Parameters<typeof createLogger>[0];
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const logger = createLogger(options.logLevel ?? 'info');

  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));
  app.use(helmet());
  app.use(
    cors({
      origin: options.allowedOrigin ?? false,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '32kb' }));
  app.use(
    rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false }),
  );
  app.use(
    '/api/v1/auth/login',
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 10,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );
  app.use((request, _response, next) => {
    const origin = request.headers.origin;
    if (origin && options.allowedOrigin && origin !== options.allowedOrigin) {
      next(new HttpError(403, 'ORIGIN_FORBIDDEN', 'The request origin is not allowed.'));
      return;
    }
    next();
  });

  app.get('/api/v1/health', (_request, response) => {
    response.status(200).json({
      data: {
        status: 'ok',
      },
    });
  });
  app.get('/api/v1/ready', async (_request, response) => {
    await query('SELECT 1');
    response.status(200).json({ data: { status: 'ready' } });
  });

  app.use('/api/v1', authRouter);
  app.use('/api/v1', huntRouter);
  app.use('/api/v1', leaderboardRouter);
  app.use('/api/v1', adminRouter);

  const notFoundHandler: RequestHandler = (_request, response) => {
    response.status(404).json({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'The requested resource is unavailable.',
      },
    });
  };

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

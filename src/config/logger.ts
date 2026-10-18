import pino from 'pino';

import type { env } from './env.js';

type LogLevel = (typeof env)['LOG_LEVEL'];

export function createLogger(level: LogLevel = 'info') {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
      ],
      censor: '[REDACTED]',
    },
  });
}

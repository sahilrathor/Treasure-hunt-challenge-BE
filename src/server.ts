import { resolve } from 'node:path';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { runSqlFiles } from './scripts/run-sql-files.js';

// Auto-run schema migrations on startup to prevent schema divergence
try {
  await runSqlFiles(resolve('database/migrations'), 'schema_migrations');
} catch (error) {
  console.error('Failed to run schema migrations on startup:', error);
}

const app = createApp({
  allowedOrigin: env.FRONTEND_ORIGIN,
  logLevel: env.LOG_LEVEL,
  environment: env.NODE_ENV,
});

const server = app.listen(env.PORT, () => {
  console.info(`College Fest Hunt API listening on port ${env.PORT}`);
});

function shutDown(signal: NodeJS.Signals) {
  console.info(`${signal} received; closing HTTP server`);
  server.close((error) => {
    if (error) {
      console.error('HTTP server failed to close cleanly', error);
      process.exitCode = 1;
    }
    void pool.end();
  });
}

process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);

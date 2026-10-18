import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';

const app = createApp({
  allowedOrigin: env.FRONTEND_ORIGIN,
  logLevel: env.LOG_LEVEL,
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

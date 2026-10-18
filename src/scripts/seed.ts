import { resolve } from 'node:path';

import { pool } from '../db/pool.js';
import { runSqlFiles } from './run-sql-files.js';

try {
  await runSqlFiles(resolve('database/seeds'), 'seed_migrations');
} finally {
  await pool.end();
}

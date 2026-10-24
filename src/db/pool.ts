import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { env } from '../config/env.js';

const databaseSslRequired =
  env.DATABASE_SSL === 'require' ||
  (env.DATABASE_SSL === undefined && env.NODE_ENV === 'production');

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.NODE_ENV === 'test' ? 4 : 12,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: databaseSslRequired ? { rejectUnauthorized: true } : false,
});

pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error', error));

export type DatabaseClient = Pick<PoolClient, 'query'>;

export async function query<Row extends QueryResultRow>(text: string, values: unknown[] = []) {
  return pool.query<Row>(text, values);
}

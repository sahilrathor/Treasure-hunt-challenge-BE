import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { pool } from '../db/pool.js';

export async function runSqlFiles(
  directory: string,
  trackingTable: 'schema_migrations' | 'seed_migrations',
) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${trackingTable} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = await pool.query(`SELECT 1 FROM ${trackingTable} WHERE name = $1`, [file]);
    if (applied.rowCount) continue;
    const sql = await readFile(resolve(directory, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO ${trackingTable}(name) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      console.info(`Applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

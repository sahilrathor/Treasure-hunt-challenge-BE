import argon2 from 'argon2';
import { z } from 'zod';

import { pool, query } from '../db/pool.js';

const input = z
  .object({ email: z.string().email(), password: z.string().min(12), name: z.string().min(2) })
  .parse({
    email: process.argv[2],
    password: process.argv[3],
    name: process.argv[4],
  });

try {
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  await query(
    `INSERT INTO admin_users(email, display_name, password_hash, role) VALUES ($1,$2,$3,'SUPER_ADMIN') ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash`,
    [input.email, input.name, passwordHash],
  );
  console.info(`Administrator ${input.email} is ready.`);
} finally {
  await pool.end();
}

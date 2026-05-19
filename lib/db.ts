import { neon } from '@neondatabase/serverless';
import { env } from 'node:process';

export type NeonClient = ReturnType<typeof neon>;

export function getDb(opts: { unpooled?: boolean } = {}): NeonClient {
  const varName = opts.unpooled ? 'DATABASE_URL_UNPOOLED' : 'DATABASE_URL';
  const url = env[varName];
  if (!url) throw new Error(`${varName} not set`);
  return neon(url);
}

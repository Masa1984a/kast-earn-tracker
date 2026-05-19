import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

async function main(): Promise<void> {
  const file = argv[2];
  if (!file) {
    console.error('Usage: tsx --env-file=.env.local scripts/apply-migration.ts <migration.sql>');
    exit(1);
  }

  const url = env.DATABASE_URL_UNPOOLED;
  if (!url) {
    console.error('DATABASE_URL_UNPOOLED not set');
    exit(1);
  }

  const sql = neon(url);

  const raw = readFileSync(file, 'utf8');
  const stripped = raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`[apply-migration] ${file} — ${statements.length} statement(s)`);
  for (const [i, stmt] of statements.entries()) {
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
    console.log(`  [${i + 1}/${statements.length}] ${preview}${stmt.length > 80 ? '...' : ''}`);
    await sql.query(stmt);
  }

  const tables = (await sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `) as Array<{ tablename: string }>;
  console.log('[apply-migration] tables in public schema:');
  for (const row of tables) {
    console.log(`  - ${row.tablename}`);
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

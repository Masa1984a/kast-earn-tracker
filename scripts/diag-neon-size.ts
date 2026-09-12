/**
 * 調査用: Neon のストレージ消費の内訳を出す（Phase 18: 512 MB 上限到達）
 *
 *   npx tsx --env-file=.env.local scripts/diag-neon-size.ts
 *   npx tsx --env-file=.env.local scripts/diag-neon-size.ts --vacuum
 *
 * --vacuum: dead tuple を VACUUM で回収可能にしてから計測する（データは消えない）。
 *           VACUUM FULL は使わない — 一時的に倍の容量が要るので上限到達時に走らせてはいけない。
 */
import { argv, exit } from 'node:process';
import { getDb } from '../lib/db';

const VACUUM_TARGETS = ['gauntlet_snapshots', 'kast_base_wallets', 'usdky_snapshots', 'dune_jobs'];

async function main() {
  const sql = getDb({ unpooled: true });

  if (argv.includes('--vacuum')) {
    console.log('=== 0. VACUUM (ANALYZE) ===');
    for (const [i, t] of VACUUM_TARGETS.entries()) {
      const started = Date.now();
      await sql.query(`VACUUM (ANALYZE) ${t}`);
      console.log(`  [${i + 1} / ${VACUUM_TARGETS.length}] ${t} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }
    console.log('');
  }

  console.log('=== 1. database 全体 ===');
  const dbSize = (await sql`
    SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
           pg_database_size(current_database())::bigint AS bytes
  `) as Array<{ size: string; bytes: string }>;
  console.log(`  ${dbSize[0].size} (${dbSize[0].bytes} bytes)`);

  console.log('\n=== 2. テーブル別 (table / index / total) ===');
  const tables = (await sql`
    SELECT c.relname AS name,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
           pg_size_pretty(pg_table_size(c.oid))          AS heap,
           pg_size_pretty(pg_indexes_size(c.oid))        AS idx,
           pg_total_relation_size(c.oid)::bigint         AS total_bytes,
           c.reltuples::bigint                           AS est_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
  `) as Array<Record<string, string>>;
  for (const t of tables) {
    console.log(
      `  ${String(t.name).padEnd(24)} total=${String(t.total).padStart(9)}` +
        ` heap=${String(t.heap).padStart(9)} idx=${String(t.idx).padStart(9)} rows≈${t.est_rows}`,
    );
  }

  console.log('\n=== 3. index 別 ===');
  const idx = (await sql`
    SELECT indexrelname AS name, relname AS tbl,
           pg_size_pretty(pg_relation_size(indexrelid)) AS size,
           idx_scan
    FROM pg_stat_user_indexes
    ORDER BY pg_relation_size(indexrelid) DESC
  `) as Array<Record<string, string>>;
  for (const i of idx) {
    console.log(
      `  ${String(i.name).padEnd(30)} ${String(i.size).padStart(9)} on ${String(i.tbl).padEnd(22)} scans=${i.idx_scan}`,
    );
  }

  console.log('\n=== 4. 明細テーブルの日次コスト ===');
  const perDay = (await sql`
    SELECT 'gauntlet_snapshots' AS t,
           COUNT(*)::bigint AS rows,
           COUNT(DISTINCT snapshot_date)::int AS days,
           (COUNT(*) / GREATEST(COUNT(DISTINCT snapshot_date), 1))::int AS rows_per_day,
           MIN(snapshot_date)::text AS min_d, MAX(snapshot_date)::text AS max_d
    FROM gauntlet_snapshots
    UNION ALL
    SELECT 'usdky_snapshots', COUNT(*)::bigint, COUNT(DISTINCT snapshot_date)::int,
           (COUNT(*) / GREATEST(COUNT(DISTINCT snapshot_date), 1))::int,
           MIN(snapshot_date)::text, MAX(snapshot_date)::text
    FROM usdky_snapshots
  `) as Array<Record<string, string>>;
  for (const r of perDay) {
    console.log(`  ${String(r.t).padEnd(20)} ${r.rows} rows / ${r.days} days = ${r.rows_per_day} rows/day (${r.min_d} .. ${r.max_d})`);
  }

  console.log('\n=== 5. dead tuples（VACUUM で回収可能な分） ===');
  const dead = (await sql`
    SELECT relname AS name, n_live_tup, n_dead_tup, last_vacuum, last_autovacuum
    FROM pg_stat_user_tables
    WHERE n_dead_tup > 0
    ORDER BY n_dead_tup DESC
  `) as Array<Record<string, string>>;
  if (dead.length === 0) console.log('  (なし)');
  for (const d of dead) {
    console.log(`  ${String(d.name).padEnd(24)} live=${d.n_live_tup} dead=${d.n_dead_tup} last_autovacuum=${d.last_autovacuum ?? '-'}`);
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

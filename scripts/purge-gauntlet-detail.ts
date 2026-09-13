/**
 * Phase 19: `gauntlet_snapshots`（ホルダー明細）の古い日を削除して増加を止める。
 *
 * グラフ / サマリは `gauntlet_daily_rollup` を読むので、明細を消しても全期間の推移は残る。
 * 消えるのは「個別ウォレットの保持期間より前の履歴」と「その日の /api/holders 明細」だけ。
 *
 * 安全策:
 *   - 集計行 (scope='all') が存在しない日は削除しない
 *   - --yes を付けない限り削除しない（既定は dry-run 相当の確認出力）
 *   - 1 日ずつ削除し、一定日数ごとに VACUUM して Neon の容量上限に触れないようにする
 *
 *   npx tsx --env-file=.env.local scripts/purge-gauntlet-detail.ts --keep-days 90
 *   npx tsx --env-file=.env.local scripts/purge-gauntlet-detail.ts --keep-days 90 --yes
 */
import { argv, exit } from 'node:process';
import { getDb } from '../lib/db';

/** 何日ぶん削除するごとに VACUUM するか */
const VACUUM_EVERY = 30;

function parseArgs() {
  let keepDays = 90;
  let yes = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep-days') keepDays = Number(argv[++i]);
    else if (a === '--yes') yes = true;
    else if (a === '--dry-run') yes = false;
    else {
      console.error(`unknown argument: ${a}`);
      exit(1);
    }
  }
  if (!Number.isInteger(keepDays) || keepDays < 7) {
    console.error(`invalid --keep-days: ${keepDays} (7 以上の整数)`);
    exit(1);
  }
  return { keepDays, yes };
}

async function main() {
  const { keepDays, yes } = parseArgs();
  const sql = getDb({ unpooled: true });

  const [anchor] = (await sql`
    SELECT MAX(snapshot_date)::text AS max_d,
           (MAX(snapshot_date) - ${keepDays}::int)::text AS cutoff
    FROM gauntlet_snapshots
  `) as Array<{ max_d: string | null; cutoff: string | null }>;
  if (!anchor?.cutoff) {
    console.log('gauntlet_snapshots が空。何もしない');
    return;
  }
  console.log(`最新日 ${anchor.max_d} / 保持 ${keepDays} 日 → ${anchor.cutoff} より前を削除対象にする`);

  // 集計が無い日は消さない（消したら二度と作れないため）
  const targets = (await sql`
    SELECT gs.snapshot_date::text AS d, COUNT(*)::int AS rows,
           EXISTS (
             SELECT 1 FROM gauntlet_daily_rollup r
             WHERE r.snapshot_date = gs.snapshot_date AND r.scope = 'all'
           ) AS has_rollup
    FROM gauntlet_snapshots gs
    WHERE gs.snapshot_date < ${anchor.cutoff}::date
    GROUP BY gs.snapshot_date
    ORDER BY gs.snapshot_date
  `) as Array<{ d: string; rows: number; has_rollup: boolean }>;

  const deletable = targets.filter((t) => t.has_rollup);
  const skipped = targets.filter((t) => !t.has_rollup);
  const totalRows = deletable.reduce((a, t) => a + t.rows, 0);

  console.log(`削除対象 ${deletable.length} 日 / ${totalRows} 行`);
  if (skipped.length > 0) {
    console.log(`集計行が無いためスキップ ${skipped.length} 日: ${skipped.map((t) => t.d).join(', ')}`);
    console.log('→ 先に scripts/backfill-gauntlet-rollup.ts --missing-only を実行すること');
  }
  if (deletable.length === 0) return;

  if (!yes) {
    console.log(`\n--yes が無いので削除しない。実行するなら:`);
    console.log(`  npx tsx --env-file=.env.local scripts/purge-gauntlet-detail.ts --keep-days ${keepDays} --yes`);
    return;
  }

  let deleted = 0;
  for (const [i, t] of deletable.entries()) {
    await sql`DELETE FROM gauntlet_snapshots WHERE snapshot_date = ${t.d}::date`;
    deleted += t.rows;
    if ((i + 1) % 10 === 0 || i === deletable.length - 1) {
      console.log(`  [${i + 1} / ${deletable.length}] ${t.d} まで削除 (${deleted} / ${totalRows} 行)`);
    }
    if ((i + 1) % VACUUM_EVERY === 0) {
      await sql.query('VACUUM gauntlet_snapshots');
      console.log(`    VACUUM 実行`);
    }
  }
  await sql.query('VACUUM (ANALYZE) gauntlet_snapshots');

  const [after] = (await sql`
    SELECT COUNT(*)::bigint AS rows,
           COUNT(DISTINCT snapshot_date)::int AS days,
           MIN(snapshot_date)::text AS min_d,
           MAX(snapshot_date)::text AS max_d
    FROM gauntlet_snapshots
  `) as Array<Record<string, string>>;
  const [size] = (await sql`
    SELECT pg_size_pretty(pg_database_size(current_database())) AS size
  `) as Array<{ size: string }>;
  console.log(`\ngauntlet_snapshots: ${after.rows} rows / ${after.days} days (${after.min_d} .. ${after.max_d})`);
  console.log(`database: ${size.size}`);
  console.log('※ 削除しても Neon の使用量はすぐには減らない（空きページとして再利用される）。増加が止まるのが目的');
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

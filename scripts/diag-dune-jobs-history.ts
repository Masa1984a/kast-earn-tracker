/**
 * 調査用: dune_jobs 全履歴の「実行が途切れた期間」と月次パターンを洗い出す
 * (Dune クレジット枯渇 → 月次リセットで復帰 という仮説の検証)
 *
 *   npx tsx --env-file=.env.local scripts/diag-dune-jobs-history.ts
 */
import { exit } from 'node:process';
import { getDb } from '../lib/db';

async function main() {
  const sql = getDb({ unpooled: true });

  console.log('=== A. gauntlet_daily の kickoff 日と、前回 kickoff からの日数ギャップ ===');
  const gaps = (await sql`
    WITH d AS (
      SELECT DISTINCT created_at::date AS day
      FROM dune_jobs
      WHERE job_kind = 'gauntlet_daily'
    )
    SELECT day::text AS day,
           (day - LAG(day) OVER (ORDER BY day))::int AS gap_days
    FROM d
    ORDER BY day
  `) as Array<{ day: string; gap_days: number | null }>;
  for (const r of gaps) {
    if (r.gap_days !== null && r.gap_days > 1) {
      console.log(`  ${r.day}: 前回から ${r.gap_days} 日空き  <== GAP (${r.gap_days - 1} 日 kickoff なし)`);
    }
  }
  console.log(`  (kickoff 日総数: ${gaps.length} / 初回 ${gaps[0]?.day} / 最終 ${gaps[gaps.length - 1]?.day})`);

  console.log('\n=== B. 月別 job 件数 x status ===');
  const monthly = (await sql`
    SELECT to_char(created_at, 'YYYY-MM') AS ym, job_kind, status, COUNT(*)::int AS n
    FROM dune_jobs
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `) as Array<{ ym: string; job_kind: string; status: string; n: number }>;
  for (const r of monthly) console.log(`  ${r.ym} ${r.job_kind.padEnd(24)} ${r.status.padEnd(10)} ${r.n}`);

  console.log('\n=== C. status 別 error_message 集計 (全期間) ===');
  const errs = (await sql`
    SELECT status, COALESCE(error_message, '(none)') AS err, COUNT(*)::int AS n,
           MIN(created_at)::date::text AS first_seen, MAX(created_at)::date::text AS last_seen
    FROM dune_jobs
    GROUP BY 1, 2
    ORDER BY n DESC
  `) as Array<Record<string, unknown>>;
  for (const r of errs) console.log(`  ${r.status} | ${r.err} | n=${r.n} | ${r.first_seen} .. ${r.last_seen}`);

  console.log('\n=== D. 日別 kickoff 有無カレンダー (2026-06-01 以降) ===');
  const cal = (await sql`
    SELECT d::date::text AS day,
           COUNT(j.id) FILTER (WHERE j.job_kind = 'gauntlet_daily')::int AS snap,
           COUNT(j.id) FILTER (WHERE j.job_kind = 'gauntlet_price')::int AS price,
           COUNT(j.id) FILTER (WHERE j.job_kind = 'kast_base_wallets_daily')::int AS kast,
           string_agg(DISTINCT j.status, ',') AS statuses
    FROM generate_series('2026-06-01'::date, current_date, interval '1 day') AS d
    LEFT JOIN dune_jobs j ON j.created_at::date = d::date
    GROUP BY d
    ORDER BY d
  `) as Array<Record<string, unknown>>;
  for (const r of cal) {
    const none = Number(r.snap) + Number(r.price) + Number(r.kast) === 0 ? '  <== NO KICKOFF AT ALL' : '';
    console.log(`  ${r.day}: snap=${r.snap} price=${r.price} kast=${r.kast} [${r.statuses ?? '-'}]${none}`);
  }

  console.log('\n=== E. 直近の Dune 由来行数 (1 回の results 取得サイズの推移) ===');
  const rowsTrend = (await sql`
    SELECT created_at::date::text AS day, job_kind, rows_count
    FROM dune_jobs
    WHERE status = 'completed' AND rows_count IS NOT NULL
      AND created_at >= current_date - interval '75 days'
    ORDER BY created_at
  `) as Array<{ day: string; job_kind: string; rows_count: number }>;
  const byKind = new Map<string, Array<{ day: string; n: number }>>();
  for (const r of rowsTrend) {
    if (!byKind.has(r.job_kind)) byKind.set(r.job_kind, []);
    byKind.get(r.job_kind)!.push({ day: r.day, n: r.rows_count });
  }
  for (const [kind, arr] of byKind) {
    console.log(`  ${kind}: ${arr[0].day}=${arr[0].n} rows → ${arr[arr.length - 1].day}=${arr[arr.length - 1].n} rows (n=${arr.length} runs)`);
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

/**
 * 調査用: Gauntlet Alpha のグラフ欠損の原因切り分け
 *
 *   npx tsx --env-file=.env.local scripts/diag-gauntlet-gap.ts
 *   npx tsx --env-file=.env.local scripts/diag-gauntlet-gap.ts --from 2026-08-15 --to 2026-09-12
 *
 * --from / --to を省略した場合は「直近 30 日」を見る。
 */
import { argv, exit } from 'node:process';
import { getDb } from '../lib/db';

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function parseArgs(): { from: string; to: string } {
  let from = isoDaysAgo(30);
  let to = isoDaysAgo(0);
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      exit(1);
    }
  }
  for (const [k, v] of [['--from', from], ['--to', to]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      console.error(`invalid ${k}: ${v} (YYYY-MM-DD)`);
      exit(1);
    }
  }
  return { from, to };
}

const { from: FROM, to: TO } = parseArgs();

async function main() {
  const sql = getDb({ unpooled: true });

  console.log(`=== 1. gauntlet_snapshots 日次 (${FROM} .. ${TO}) ===`);
  const snaps = (await sql`
    SELECT d::date::text AS d,
           gs.holders,
           gs.tvl_usd,
           gs.share_price
    FROM generate_series(${FROM}::date, ${TO}::date, interval '1 day') AS d
    LEFT JOIN (
      SELECT snapshot_date,
             COUNT(*)::int AS holders,
             ROUND(SUM(usd_value)::numeric, 2) AS tvl_usd,
             MAX(share_price)::text AS share_price
      FROM gauntlet_snapshots
      GROUP BY snapshot_date
    ) gs ON gs.snapshot_date = d::date
    ORDER BY d
  `) as Array<Record<string, unknown>>;
  for (const r of snaps) {
    const missing = r.holders === null ? '  <== MISSING' : '';
    console.log(`  ${r.d}: holders=${r.holders ?? '-'} tvl=${r.tvl_usd ?? '-'} sp=${r.share_price ?? '-'}${missing}`);
  }

  console.log(`\n=== 2. gauntlet_share_prices 日次 (${FROM} .. ${TO}) ===`);
  const prices = (await sql`
    SELECT d::date::text AS d, gp.share_price::text AS share_price,
           gp.enter_events_today, gp.daily_volume_usdc::text AS vol
    FROM generate_series(${FROM}::date, ${TO}::date, interval '1 day') AS d
    LEFT JOIN gauntlet_share_prices gp ON gp.effective_date = d::date
    ORDER BY d
  `) as Array<Record<string, unknown>>;
  for (const r of prices) {
    const missing = r.share_price === null ? '  <== MISSING' : '';
    console.log(`  ${r.d}: sp=${r.share_price ?? '-'} events=${r.enter_events_today ?? '-'} vol=${r.vol ?? '-'}${missing}`);
  }

  console.log(`\n=== 3. usdky_snapshots 日次 (比較用) ===`);
  const usdky = (await sql`
    SELECT d::date::text AS d, us.holders, us.tvl_usd
    FROM generate_series(${FROM}::date, ${TO}::date, interval '1 day') AS d
    LEFT JOIN (
      SELECT snapshot_date, COUNT(*)::int AS holders, ROUND(SUM(usd_value)::numeric, 2) AS tvl_usd
      FROM usdky_snapshots GROUP BY snapshot_date
    ) us ON us.snapshot_date = d::date
    ORDER BY d
  `) as Array<Record<string, unknown>>;
  for (const r of usdky) {
    const missing = r.holders === null ? '  <== MISSING' : '';
    console.log(`  ${r.d}: holders=${r.holders ?? '-'} tvl=${r.tvl_usd ?? '-'}${missing}`);
  }

  console.log(`\n=== 4. dune_jobs (created_at ${FROM} 以降, 全件) ===`);
  const jobs = (await sql`
    SELECT id, job_kind, status, query_id,
           created_at, started_at, completed_at,
           rows_count, error_message, params
    FROM dune_jobs
    WHERE created_at >= ${FROM}::date
    ORDER BY id
  `) as Array<Record<string, unknown>>;
  console.log(`  (${jobs.length} jobs)`);
  for (const j of jobs) {
    const created = j.created_at instanceof Date ? j.created_at.toISOString() : String(j.created_at);
    const done = j.completed_at instanceof Date ? j.completed_at.toISOString() : String(j.completed_at);
    console.log(
      `  #${j.id} ${j.job_kind} q=${j.query_id} ${j.status} created=${created} completed=${done} rows=${j.rows_count ?? '-'} err=${j.error_message ?? '-'} params=${JSON.stringify(j.params)}`,
    );
  }

  console.log(`\n=== 5. dune_jobs job_kind 別 日次カウント (${FROM} 以降) ===`);
  const jobsByDay = (await sql`
    SELECT created_at::date::text AS d, job_kind, status, COUNT(*)::int AS n
    FROM dune_jobs
    WHERE created_at >= ${FROM}::date
    GROUP BY created_at::date, job_kind, status
    ORDER BY d, job_kind
  `) as Array<Record<string, unknown>>;
  for (const r of jobsByDay) console.log(`  ${r.d} ${r.job_kind} ${r.status}: ${r.n}`);

  console.log(`\n=== 6. 全体レンジ ===`);
  const ranges = (await sql`
    SELECT 'gauntlet_snapshots' AS t,
           MIN(snapshot_date)::text AS min_d, MAX(snapshot_date)::text AS max_d,
           COUNT(DISTINCT snapshot_date)::int AS days, COUNT(*)::int AS rows
    FROM gauntlet_snapshots
    UNION ALL
    SELECT 'gauntlet_share_prices', MIN(effective_date)::text, MAX(effective_date)::text,
           COUNT(DISTINCT effective_date)::int, COUNT(*)::int
    FROM gauntlet_share_prices
    UNION ALL
    SELECT 'usdky_snapshots', MIN(snapshot_date)::text, MAX(snapshot_date)::text,
           COUNT(DISTINCT snapshot_date)::int, COUNT(*)::int
    FROM usdky_snapshots
  `) as Array<Record<string, unknown>>;
  for (const r of ranges) console.log(`  ${r.t}: ${r.min_d} .. ${r.max_d} (${r.days} days / ${r.rows} rows)`);

  console.log(`\n=== 7. gauntlet_snapshots 欠損日 全期間リスト ===`);
  const gaps = (await sql`
    SELECT d::date::text AS d
    FROM generate_series(
      (SELECT MIN(snapshot_date) FROM gauntlet_snapshots),
      (SELECT MAX(snapshot_date) FROM gauntlet_snapshots),
      interval '1 day'
    ) AS d
    WHERE NOT EXISTS (
      SELECT 1 FROM gauntlet_snapshots gs WHERE gs.snapshot_date = d::date
    )
    ORDER BY d
  `) as Array<{ d: string }>;
  console.log(`  ${gaps.length} 日欠損: ${gaps.map((g) => g.d).join(', ') || '(なし)'}`);

  console.log(`
=== 8b. KAST filter 経路（画面が実際に使う INNER JOIN kast_base_wallets）===`);
  const kast = (await sql`
    SELECT gs.snapshot_date::text AS d,
           COUNT(*)::int AS kast_holders,
           ROUND(SUM(gs.usd_value)::numeric, 0)::text AS kast_tvl
    FROM gauntlet_snapshots gs
    INNER JOIN kast_base_wallets kbw ON kbw.wallet = gs.holder
    WHERE gs.snapshot_date BETWEEN ${FROM}::date AND ${TO}::date
    GROUP BY gs.snapshot_date
    ORDER BY gs.snapshot_date
  `) as Array<Record<string, string>>;
  for (const r of kast) console.log(`  ${r.d}: kast_holders=${r.kast_holders} kast_tvl=${r.kast_tvl}`);

  console.log(`\n=== 8. gauntlet_share_prices 欠損日 全期間リスト ===`);
  const priceGaps = (await sql`
    SELECT d::date::text AS d
    FROM generate_series(
      (SELECT MIN(effective_date) FROM gauntlet_share_prices),
      (SELECT MAX(effective_date) FROM gauntlet_share_prices),
      interval '1 day'
    ) AS d
    WHERE NOT EXISTS (
      SELECT 1 FROM gauntlet_share_prices gp WHERE gp.effective_date = d::date
    )
    ORDER BY d
  `) as Array<{ d: string }>;
  console.log(`  ${priceGaps.length} 日欠損: ${priceGaps.map((g) => g.d).join(', ') || '(なし)'}`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

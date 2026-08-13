/**
 * 検証用: dune-kickoff の欠損検知 SQL（15.3.3）が Neon で成立するか + 算出される window の確認。
 * route 側と同じ SQL / 同じ日付計算を再現する。
 *
 *   npx tsx --env-file=.env.local scripts/diag-kickoff-window.ts [YYYY-MM-DD]
 */
import { argv, exit } from 'node:process';
import { getDb } from '../lib/db';

const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 30;

function isoDaysAgo(endDate: string, days: number): string {
  return new Date(Date.parse(`${endDate}T00:00:00Z`) - days * 86400_000)
    .toISOString()
    .slice(0, 10);
}

async function main() {
  const endDate = argv[2] ?? new Date().toISOString().slice(0, 10);
  const sql = getDb({ unpooled: true });

  const snap = (await sql`
    SELECT MIN(d)::date::text AS earliest_missing, COUNT(*)::int AS missing_days
    FROM generate_series(
      ${endDate}::date - ${MAX_LOOKBACK_DAYS}::int,
      ${endDate}::date - 1,
      interval '1 day'
    ) AS d
    WHERE NOT EXISTS (
      SELECT 1 FROM gauntlet_snapshots gs WHERE gs.snapshot_date = d::date
    )
  `) as Array<{ earliest_missing: string | null; missing_days: number }>;

  const price = (await sql`
    SELECT MIN(d)::date::text AS earliest_missing, COUNT(*)::int AS missing_days
    FROM generate_series(
      ${endDate}::date - ${MAX_LOOKBACK_DAYS}::int,
      ${endDate}::date - 1,
      interval '1 day'
    ) AS d
    WHERE NOT EXISTS (
      SELECT 1 FROM gauntlet_share_prices gp WHERE gp.effective_date = d::date
    )
  `) as Array<{ earliest_missing: string | null; missing_days: number }>;

  const defaultStart = isoDaysAgo(endDate, DEFAULT_LOOKBACK_DAYS);
  const capAt = isoDaysAgo(endDate, MAX_LOOKBACK_DAYS);

  for (const [label, row] of [
    ['snapshots', snap[0]],
    ['price', price[0]],
  ] as const) {
    const earliest = row.earliest_missing;
    const start = earliest && earliest < defaultStart ? earliest : defaultStart;
    const capped = earliest !== null && earliest <= capAt;
    console.log(
      `${label.padEnd(10)} earliest_missing=${earliest ?? '(none)'} missing_days=${row.missing_days} ` +
        `→ window ${start} .. ${endDate}${capped ? '  <== CAPPED (要手動 backfill)' : ''}`,
    );
  }
  console.log(`\n(end_date=${endDate} / default_start=${defaultStart} / cap=${capAt})`);

  console.log('\n--- backfill jobs (直近 4 件) ---');
  const jobs = (await sql`
    SELECT id, job_kind, status, rows_count, error_message,
           created_at, completed_at
    FROM dune_jobs ORDER BY id DESC LIMIT 4
  `) as Array<Record<string, unknown>>;
  for (const j of jobs) {
    const c = j.created_at instanceof Date ? j.created_at.toISOString() : String(j.created_at);
    const f = j.completed_at instanceof Date ? j.completed_at.toISOString() : String(j.completed_at);
    console.log(`  #${j.id} ${j.job_kind} ${j.status} rows=${j.rows_count ?? '-'} err=${j.error_message ?? '-'} created=${c} completed=${f}`);
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

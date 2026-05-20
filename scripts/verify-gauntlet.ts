/**
 * Phase 9 動作確認: smoke test 後の Neon レコード検証
 */
import { exit } from 'node:process';
import { getDb } from '../lib/db';

const PROBE_WALLET = '0x371002be73300a256cf9376e2f4a59ee00902cae';

async function main() {
  const sql = getDb({ unpooled: true });

  console.log('--- dune_jobs (last 5) ---');
  const jobs = (await sql`
    SELECT id, job_kind, status, started_at, completed_at, rows_count, error_message
    FROM dune_jobs ORDER BY id DESC LIMIT 5
  `) as Array<Record<string, unknown>>;
  for (const j of jobs) console.log(j);

  console.log('\n--- gauntlet_share_prices ---');
  const prices = (await sql`
    SELECT effective_date, share_price, enter_events_today, daily_volume_usdc
    FROM gauntlet_share_prices ORDER BY effective_date
  `) as Array<Record<string, unknown>>;
  for (const p of prices) console.log(p);

  console.log('\n--- gauntlet_snapshots aggregates ---');
  const agg = (await sql`
    SELECT
      MIN(snapshot_date) AS min_d,
      MAX(snapshot_date) AS max_d,
      COUNT(DISTINCT snapshot_date) AS days,
      COUNT(*) AS rows,
      COUNT(DISTINCT holder) AS holders,
      SUM(usd_value) FILTER (WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM gauntlet_snapshots)) AS tvl_latest
    FROM gauntlet_snapshots
  `) as Array<Record<string, unknown>>;
  console.log(agg[0]);

  console.log('\n--- probe wallet across dates ---');
  const probe = (await sql`
    SELECT snapshot_date, shares, share_price, usd_value
    FROM gauntlet_snapshots
    WHERE holder = ${PROBE_WALLET}
    ORDER BY snapshot_date DESC
  `) as Array<Record<string, unknown>>;
  for (const r of probe) console.log(r);

  console.log('\n--- latest day TVL sanity check ---');
  const tvl = (await sql`
    SELECT snapshot_date, COUNT(*) AS holders, SUM(usd_value)::numeric AS tvl_usd, AVG(share_price)::numeric AS share_price
    FROM gauntlet_snapshots
    GROUP BY snapshot_date
    ORDER BY snapshot_date DESC
    LIMIT 8
  `) as Array<Record<string, unknown>>;
  for (const r of tvl) console.log(r);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

import { exit } from 'node:process';
import { getDb } from '../lib/db';

const MY_WALLET = '4QvVC4Cc3UWvFk97VwWWV7AvNg6L7XGXu9GFBKgHPMDD';

async function main(): Promise<void> {
  const db = getDb({ unpooled: true });

  // 8.1 — record counts and date range
  const [{ rows, days, owners, min_d, max_d }] = (await db`
    SELECT
      COUNT(*)::int           AS rows,
      COUNT(DISTINCT snapshot_date)::int AS days,
      COUNT(DISTINCT owner)::int         AS owners,
      MIN(snapshot_date)::text AS min_d,
      MAX(snapshot_date)::text AS max_d
    FROM usdky_snapshots
  `) as Array<{ rows: number; days: number; owners: number; min_d: string; max_d: string }>;
  console.log(`[8.1] usdky_snapshots: ${rows} rows, ${days} days (${min_d} .. ${max_d}), ${owners} owners`);

  const [{ tx_rows, mult_rows }] = (await db`
    SELECT
      (SELECT COUNT(*)::int FROM usdky_tx_log)        AS tx_rows,
      (SELECT COUNT(*)::int FROM usdky_multipliers)   AS mult_rows
  `) as Array<{ tx_rows: number; mult_rows: number }>;
  console.log(`[8.1] usdky_tx_log: ${tx_rows} rows`);
  console.log(`[8.1] usdky_multipliers: ${mult_rows} rows (deduped to one per effective_date)`);

  // Total USD on latest day
  const [{ total_usd, holder_count }] = (await db`
    SELECT
      COALESCE(SUM(usd_value), 0)::text AS total_usd,
      COUNT(*)::int                     AS holder_count
    FROM usdky_snapshots
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM usdky_snapshots)
  `) as Array<{ total_usd: string; holder_count: number }>;
  console.log(`[8.1] latest day: ${holder_count} holders, total USD = $${Number(total_usd).toLocaleString()}`);

  // Recent 5 multiplier updates
  const muls = (await db`
    SELECT effective_date::text AS d, multiplier::text AS m
    FROM usdky_multipliers
    ORDER BY effective_date DESC
    LIMIT 5
  `) as Array<{ d: string; m: string }>;
  console.log('[8.1] last 5 multipliers:');
  for (const r of muls) console.log(`  ${r.d}: ${r.m}`);

  // 8.4 — user wallet snapshot
  console.log(`\n[8.4] checking wallet ${MY_WALLET}`);
  const mine = (await db`
    SELECT
      snapshot_date::text AS d,
      principal::text     AS principal,
      multiplier::text    AS multiplier,
      usd_value::text     AS usd_value
    FROM usdky_snapshots
    WHERE owner = ${MY_WALLET}
    ORDER BY snapshot_date DESC
    LIMIT 5
  `) as Array<{ d: string; principal: string; multiplier: string; usd_value: string }>;
  if (mine.length === 0) {
    console.log('  no snapshot rows for this wallet — was never a holder?');
  } else {
    for (const r of mine) {
      const principalDisplay = (Number(r.principal) / 1e6).toFixed(6);
      const usdDisplay = Number(r.usd_value).toFixed(6);
      console.log(`  ${r.d}: principal=${principalDisplay} USDKY × mult=${r.multiplier} = $${usdDisplay}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

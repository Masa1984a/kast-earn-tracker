import { exit } from 'node:process';
import { getDb } from '../lib/db';

async function main(): Promise<void> {
  const db = getDb({ unpooled: true });

  // 1. Real top 10 day-over-day TVL jumps (ORDER BY on the numeric column, NOT the text alias)
  console.log('=== Top 10 days by TVL day-over-day growth (numeric order) ===');
  const jumps = (await db`
    WITH daily AS (
      SELECT snapshot_date, SUM(usd_value)::numeric AS tvl
      FROM usdky_snapshots
      GROUP BY snapshot_date
    ),
    diffs AS (
      SELECT snapshot_date, tvl, tvl - LAG(tvl) OVER (ORDER BY snapshot_date) AS d_tvl
      FROM daily
    ),
    ranked AS (
      SELECT snapshot_date, tvl, d_tvl
      FROM diffs
      WHERE d_tvl IS NOT NULL
      ORDER BY d_tvl DESC
      LIMIT 15
    )
    SELECT snapshot_date::text AS d, tvl::float AS tvl, d_tvl::float AS d_tvl
    FROM ranked
    ORDER BY d_tvl DESC
  `) as Array<{ d: string; tvl: number; d_tvl: number }>;
  for (const r of jumps) {
    console.log(
      `  ${r.d}: TVL=$${Math.round(r.tvl).toLocaleString().padStart(12)}  Δ=+$${Math.round(r.d_tvl).toLocaleString()}`,
    );
  }

  // 2. Sample of TVL series — first row of each calendar week, to see actual trajectory
  console.log('\n=== Weekly TVL samples (every Monday) ===');
  const weekly = (await db`
    SELECT snapshot_date::text AS d, SUM(usd_value)::float AS tvl, COUNT(*)::int AS holders
    FROM usdky_snapshots
    WHERE EXTRACT(DOW FROM snapshot_date) = 1
    GROUP BY snapshot_date
    ORDER BY snapshot_date
  `) as Array<{ d: string; tvl: number; holders: number }>;
  for (const r of weekly) {
    console.log(`  ${r.d}: $${Math.round(r.tvl).toLocaleString().padStart(12)} (${r.holders} holders)`);
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

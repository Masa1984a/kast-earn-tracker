import { exit } from 'node:process';
import { getDb } from '../lib/db';

async function main(): Promise<void> {
  const db = getDb({ unpooled: true });

  const txDates = (await db`
    SELECT block_time::date::text AS d, COUNT(*)::int AS n
    FROM usdky_tx_log
    GROUP BY block_time::date
    ORDER BY d
  `) as Array<{ d: string; n: number }>;
  console.log('tx_log by date:');
  for (const r of txDates) console.log(`  ${r.d}: ${r.n}`);

  const snapDates = (await db`
    SELECT snapshot_date::text AS d, COUNT(*)::int AS n,
           SUM(usd_value)::numeric(20,4) AS total_usd,
           MIN(multiplier) AS mult
    FROM usdky_snapshots
    GROUP BY snapshot_date
    ORDER BY d
  `) as Array<{ d: string; n: number; total_usd: string; mult: string }>;
  console.log('snapshots by date:');
  for (const r of snapDates) console.log(`  ${r.d}: ${r.n} owners, total_usd=${r.total_usd}, mult=${r.mult}`);

  const mults = (await db`
    SELECT effective_date::text AS d, multiplier::text AS m, block_time, signature
    FROM usdky_multipliers
    ORDER BY effective_date
  `) as Array<{ d: string; m: string; block_time: Date; signature: string }>;
  console.log('multipliers:');
  for (const r of mults) console.log(`  ${r.d}: ${r.m} (${r.block_time.toISOString()}) sig=${r.signature.slice(0, 12)}...`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

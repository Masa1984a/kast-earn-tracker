import { exit } from 'node:process';
import { getDb } from '../lib/db';

const TREASURY = '5WVYUVeJvcwD';

async function main(): Promise<void> {
  const db = getDb({ unpooled: true });

  // Find the full address from a prefix
  const [{ owner: addr }] = (await db`
    SELECT DISTINCT owner
    FROM usdky_tx_log
    WHERE owner LIKE ${TREASURY + '%'}
    LIMIT 1
  `) as Array<{ owner: string }>;
  console.log(`Treasury candidate: ${addr}`);

  // Their snapshot trajectory at key dates
  const series = (await db`
    SELECT snapshot_date::text AS d, usd_value::float AS usd, principal::float / 1e6 AS usdky
    FROM usdky_snapshots
    WHERE owner = ${addr}
    AND snapshot_date IN (
      '2025-09-22'::date, '2026-03-02'::date, '2026-03-05'::date,
      '2026-03-09'::date, '2026-03-24'::date, '2026-04-01'::date,
      '2026-04-22'::date, '2026-05-01'::date, '2026-05-19'::date
    )
    ORDER BY snapshot_date
  `) as Array<{ d: string; usd: number; usdky: number }>;
  console.log(`\nTreasury balance at key dates:`);
  for (const r of series) {
    console.log(`  ${r.d}: ${r.usdky.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDKY = $${r.usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }

  // Tx counts by kind for treasury
  const kinds = (await db`
    SELECT kind, COUNT(*)::int AS n, SUM(delta::numeric)::float / 1e6 AS net_usdky
    FROM usdky_tx_log
    WHERE owner = ${addr}
    GROUP BY kind
    ORDER BY kind
  `) as Array<{ kind: string; n: number; net_usdky: number }>;
  console.log(`\nTreasury tx counts:`);
  for (const r of kinds) {
    console.log(`  ${r.kind}: ${r.n} txs, net ${r.net_usdky >= 0 ? '+' : ''}${r.net_usdky.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDKY`);
  }

  // Top current holders
  console.log(`\nTop 10 holders on latest day:`);
  const top = (await db`
    SELECT owner, usd_value::float AS usd
    FROM usdky_snapshots
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM usdky_snapshots)
    ORDER BY usd_value DESC
    LIMIT 10
  `) as Array<{ owner: string; usd: number }>;
  for (const r of top) {
    console.log(`  ${r.owner.slice(0, 12)}...: $${Math.round(r.usd).toLocaleString()}`);
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

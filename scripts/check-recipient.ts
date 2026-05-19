import { exit } from 'node:process';
import { getDb } from '../lib/db';

const RECIPIENT = '8N8UDedojaXKzS3gAvEapS5tmEgF1uH6P95cCfF88GSC';

async function main(): Promise<void> {
  const db = getDb({ unpooled: true });

  // この owner の tx 全部
  const txs = (await db`
    SELECT signature, block_time::text AS t, kind,
           (delta::numeric / 1e6)::float AS usdky
    FROM usdky_tx_log
    WHERE owner = ${RECIPIENT}
    ORDER BY block_time
  `) as Array<{ signature: string; t: string; kind: string; usdky: number }>;
  console.log(`=== tx_log for ${RECIPIENT.slice(0, 12)}... ===`);
  for (const r of txs) {
    console.log(`  ${r.t}  kind=${r.kind}  ${r.usdky >= 0 ? '+' : ''}${r.usdky} USDKY  (${r.signature.slice(0, 8)}...)`);
  }

  // 最新 snapshot
  const [latest] = (await db`
    SELECT snapshot_date::text AS d,
           principal::float / 1e6 AS usdky,
           usd_value::float AS usd
    FROM usdky_snapshots
    WHERE owner = ${RECIPIENT}
    ORDER BY snapshot_date DESC
    LIMIT 1
  `) as Array<{ d: string; usdky: number; usd: number }>;
  console.log(`\nLatest snapshot: ${latest.d}: ${latest.usdky} USDKY = $${latest.usd.toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

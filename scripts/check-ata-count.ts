import { exit } from 'node:process';
import { getDb } from '../lib/db';

async function main(): Promise<void> {
  const db = getDb({ unpooled: true });
  const [r] = (await db`
    SELECT
      COUNT(*) FILTER (WHERE ata_count > 1)::int AS multi_ata_owners,
      MAX(ata_count)::int AS max_ata,
      COUNT(*)::int AS total
    FROM usdky_snapshots
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM usdky_snapshots)
  `) as Array<{ multi_ata_owners: number; max_ata: number; total: number }>;
  console.log(r);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

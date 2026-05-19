import { exit } from 'node:process';
import { getDb } from '../lib/db';

async function main(): Promise<void> {
  const db = getDb({ unpooled: true });
  const rows = (await db`
    SELECT DISTINCT owner
    FROM usdky_tx_log
    WHERE owner LIKE 'EGzpN9QTKLNT%' OR owner LIKE 'E1vwo1VpXafB%'
  `) as Array<{ owner: string }>;
  for (const r of rows) console.log(r.owner);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

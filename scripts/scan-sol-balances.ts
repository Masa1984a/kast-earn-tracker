import { argv, env, exit } from 'node:process';
import { getDb } from '../lib/db';
import { sleep } from '../lib/helius';

const BATCH_SIZE = 100;
const SLEEP_MS = 150;
const APPLY = argv.includes('--apply');

interface AccountInfo {
  lamports: number;
  owner: string;
  executable: boolean;
}

async function getMultipleAccounts(addresses: string[]): Promise<Array<AccountInfo | null>> {
  const key = env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [addresses, { encoding: 'base64', commitment: 'confirmed' }],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  return body.result.value as Array<AccountInfo | null>;
}

async function main(): Promise<void> {
  const db = getDb({ unpooled: true });

  console.log('Fetching all owners from latest snapshot...');
  const owners = (await db`
    SELECT s.owner,
           s.usd_value::float AS usd,
           (SELECT COUNT(*)::int FROM usdky_tx_log t WHERE t.owner = s.owner) AS tx_count,
           k.label AS label
    FROM usdky_snapshots s
    LEFT JOIN kast_known_addresses k ON k.address = s.owner
    WHERE s.snapshot_date = (SELECT MAX(snapshot_date) FROM usdky_snapshots)
    ORDER BY s.usd_value DESC
  `) as Array<{ owner: string; usd: number; tx_count: number; label: string | null }>;
  console.log(`  ${owners.length} owners on latest day`);

  console.log(`Checking SOL balance via getMultipleAccounts (${Math.ceil(owners.length / BATCH_SIZE)} batches)...`);
  const solBalance = new Map<string, number>();
  for (let i = 0; i < owners.length; i += BATCH_SIZE) {
    const batch = owners.slice(i, i + BATCH_SIZE);
    const addrs = batch.map((o) => o.owner);
    const accounts = await getMultipleAccounts(addrs);
    for (let j = 0; j < batch.length; j++) {
      const acc = accounts[j];
      if (acc && acc.lamports > 0) {
        solBalance.set(batch[j].owner, acc.lamports);
      }
    }
    process.stdout.write(`  batch ${Math.floor(i / BATCH_SIZE) + 1} done\r`);
    await sleep(SLEEP_MS);
  }
  console.log(`\n  Found ${solBalance.size} owners with SOL > 0 out of ${owners.length}`);

  // Already labeled
  console.log('\n=== Already labeled wallets ===');
  const labeled = owners.filter((o) => o.label);
  for (const o of labeled) {
    const lamports = solBalance.get(o.owner);
    const sol = lamports ? (lamports / 1e9).toFixed(4) : '0 (no System Account)';
    console.log(
      `  [${o.label}] ${o.owner.slice(0, 12)}...: SOL=${sol}, USDKY=$${Math.round(o.usd).toLocaleString()}, tx=${o.tx_count}`,
    );
  }

  // Unlabeled but with SOL — these are candidates for labeling
  console.log('\n=== Unlabeled owners with SOL > 0 (candidates for label) ===');
  const candidates = owners
    .filter((o) => !o.label && solBalance.has(o.owner))
    .sort((a, b) => b.usd - a.usd);
  console.log(`  ${candidates.length} candidates\n`);
  for (const o of candidates) {
    const lamports = solBalance.get(o.owner)!;
    const sol = (lamports / 1e9).toFixed(4);
    console.log(
      `  ${o.owner}: SOL=${sol}, USDKY=$${Math.round(o.usd).toLocaleString()}, tx=${o.tx_count}`,
    );
  }

  // Sanity: confirm pure KAST users have no SOL
  console.log('\n=== Sanity: random sample of "no SOL" (KAST custodial) wallets ===');
  const noSol = owners.filter((o) => !o.label && !solBalance.has(o.owner));
  console.log(`  ${noSol.length} owners with no SOL`);
  for (const o of noSol.slice(0, 5)) {
    console.log(
      `  ${o.owner.slice(0, 12)}...: USDKY=$${Math.round(o.usd).toLocaleString()}, tx=${o.tx_count}`,
    );
  }

  if (APPLY) {
    console.log('\n=== Applying labels (--apply) ===');
    const toInsert = candidates.map((o) => ({
      address: o.owner,
      label: 'has_sol',
      note: `lamports=${solBalance.get(o.owner)} on ${new Date().toISOString().slice(0, 10)} (detected by scan-sol-balances)`,
    }));
    if (toInsert.length === 0) {
      console.log('  no new SOL-holders to label');
      return;
    }
    await db`
      INSERT INTO kast_known_addresses (address, label, note)
      SELECT * FROM UNNEST(
        ${toInsert.map((r) => r.address)}::text[],
        ${toInsert.map((r) => r.label)}::text[],
        ${toInsert.map((r) => r.note)}::text[]
      )
      ON CONFLICT (address) DO NOTHING
    `;
    console.log(`  inserted ${toInsert.length} rows with label='has_sol' (skipping any with existing label)`);
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

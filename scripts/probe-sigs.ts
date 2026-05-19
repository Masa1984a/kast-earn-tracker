import { exit } from 'node:process';
import { getAllSignaturesForMint } from '../lib/helius';

async function main(): Promise<void> {
  console.log('Fetching all USDKY mint signatures (count-only probe)...');
  const sigs = await getAllSignaturesForMint({
    onProgress: (n) => {
      if (n % 1000 === 0 || n < 1000) process.stdout.write(`  ${n} so far\r`);
    },
  });
  console.log(`\nTotal signatures: ${sigs.length}`);
  if (sigs.length > 0) {
    const newest = sigs[0];
    const oldest = sigs[sigs.length - 1];
    const fmt = (s: typeof newest) =>
      s.blockTime ? new Date(s.blockTime * 1000).toISOString() : 'null';
    console.log(`  newest: ${fmt(newest)}`);
    console.log(`  oldest: ${fmt(oldest)}`);
    const ok = sigs.filter((s) => s.err === null).length;
    console.log(`  successful: ${ok} / ${sigs.length} (errors: ${sigs.length - ok})`);
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

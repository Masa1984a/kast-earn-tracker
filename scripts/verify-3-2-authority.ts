import { env, exit } from 'node:process';

const SCALED_UI_AUTHORITY = 'EvEenAb6tQdgUCMgv9fpgxMzLw4Cj2PcQLbJbTEreQCm';

async function main(): Promise<void> {
  const key = env.HELIUS_API_KEY;
  if (!key) {
    console.error('HELIUS_API_KEY not set');
    exit(1);
  }
  const url = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignaturesForAddress',
      params: [SCALED_UI_AUTHORITY, { limit: 30 }],
    }),
  });
  const body = await res.json();
  const sigs = body.result as Array<{
    signature: string;
    slot: number;
    blockTime: number | null;
    err: unknown;
  }>;
  console.log(`Total: ${sigs.length}`);
  for (const s of sigs) {
    const iso = s.blockTime ? new Date(s.blockTime * 1000).toISOString() : 'null';
    const errStr = s.err === null ? 'ok ' : 'ERR';
    console.log(`${iso}  slot=${s.slot}  ${errStr}  ${s.signature}`);
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

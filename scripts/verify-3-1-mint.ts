import { env, exit } from 'node:process';
import { USDKY_MINT } from '../lib/helius';

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
      method: 'getAccountInfo',
      params: [USDKY_MINT, { encoding: 'jsonParsed' }],
    }),
  });
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

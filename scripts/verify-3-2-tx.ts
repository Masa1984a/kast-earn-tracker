import { env, exit, argv } from 'node:process';

async function main(): Promise<void> {
  const sig = argv[2];
  if (!sig) {
    console.error('Usage: tsx --env-file=.env.local scripts/verify-3-2-tx.ts <signature>');
    exit(1);
  }
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
      method: 'getTransaction',
      params: [
        sig,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
      ],
    }),
  });
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

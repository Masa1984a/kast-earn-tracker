/**
 * Phase 9.3 検証: Dune query 7543001 (share_price) のスキーマ確認
 *
 * 使い方:
 *   tsx --env-file=.env.local scripts/probe-gauntlet-price.ts
 */

import { exit } from 'node:process';
import {
  executeQuery,
  getExecutionStatus,
  getExecutionResults,
  GAUNTLET_PRICE_QUERY_ID,
  GAUNTLET_VAULT,
} from '../lib/dune';

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const end_date = new Date().toISOString().slice(0, 10);
  const start_date = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const params = { start_date, end_date, vault: GAUNTLET_VAULT };

  console.log(`[probe-price] Dune query ${GAUNTLET_PRICE_QUERY_ID}`);
  console.log(`[probe-price] params = ${JSON.stringify(params)}`);

  const execution_id = await executeQuery(GAUNTLET_PRICE_QUERY_ID, params);
  console.log(`[probe-price] execution_id = ${execution_id}`);

  const start = Date.now();
  while (true) {
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed > 600) {
      console.error('[probe-price] timeout');
      exit(1);
    }
    const { state, raw } = await getExecutionStatus(execution_id);
    console.log(`[probe-price] +${elapsed}s state=${state}`);
    if (state === 'QUERY_STATE_COMPLETED') break;
    if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') {
      console.error('[probe-price] failed', raw);
      exit(1);
    }
    await sleep(5000);
  }

  const rows = await getExecutionResults(execution_id);
  console.log(`[probe-price] total rows = ${rows.length}`);
  if (rows.length === 0) {
    console.log('[probe-price] empty');
    return;
  }
  console.log('[probe-price] sample row[0] keys:', Object.keys(rows[0] as object));
  console.log('[probe-price] sample row[0]:', JSON.stringify(rows[0], null, 2));
  console.log('[probe-price] sample row[last]:', JSON.stringify(rows[rows.length - 1], null, 2));

  // 期待 schema: effective_date, share_price, enter_events_today, daily_volume_usdc
  const expectedKeys = ['effective_date', 'share_price'];
  const actualKeys = Object.keys(rows[0] as object);
  const missing = expectedKeys.filter((k) => !actualKeys.includes(k));
  if (missing.length > 0) {
    console.warn(`[probe-price] WARN: missing expected keys: ${missing.join(', ')}`);
  } else {
    console.log('[probe-price] OK: required keys present');
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

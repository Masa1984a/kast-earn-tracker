/**
 * Phase 9.1.1 / 9.1.3 関所スクリプト
 *
 * 目的:
 *   - Dune Query 7534621 (Gauntlet Alpha Vault holders) を実際に叩き、
 *     `gtusda_balance` が shares か USD 換算かを確定する
 *   - 最古 snapshot_date から vault ローンチ日を確定する
 *
 * 使い方:
 *   tsx --env-file=.env.local scripts/probe-gauntlet-dune.ts
 */

import { argv, env, exit } from 'node:process';

const DUNE_API = 'https://api.dune.com/api/v1';
const GAUNTLET_QUERY_ID = 7534621;
const GTUSDA = '0x000000000001CdB57E58Fa75Fe420a0f4D6640D5';
const PROBE_WALLET = '0x371002be73300a256cf9376e2f4a59ee00902cae';

function headers() {
  const key = env.DUNE_API_KEY;
  if (!key) {
    console.error('DUNE_API_KEY not set in .env.local');
    exit(1);
  }
  return {
    'X-Dune-API-Key': key,
    'Content-Type': 'application/json',
  } as Record<string, string>;
}

async function executeQuery(queryId: number, params: Record<string, string>): Promise<string> {
  const res = await fetch(`${DUNE_API}/query/${queryId}/execute`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query_parameters: params }),
  });
  if (!res.ok) throw new Error(`execute failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.execution_id;
}

async function getStatus(executionId: string): Promise<{ state: string; raw: any }> {
  const res = await fetch(`${DUNE_API}/execution/${executionId}/status`, { headers: headers() });
  if (!res.ok) throw new Error(`status failed: ${res.status}`);
  const j = await res.json();
  return { state: j.state, raw: j };
}

async function getResults(executionId: string): Promise<any[]> {
  const res = await fetch(`${DUNE_API}/execution/${executionId}/results`, { headers: headers() });
  if (!res.ok) throw new Error(`results failed: ${res.status}`);
  const j = await res.json();
  return j.result.rows;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // 全期間広めに取って最古日も同時に確認する（params start_date は vault ローンチより前で OK）
  const start_date = argv[2] ?? '2025-01-01';
  const end_date = argv[3] ?? new Date().toISOString().slice(0, 10);
  const params = { start_date, end_date, token: GTUSDA };

  console.log(`[probe] Dune query ${GAUNTLET_QUERY_ID}`);
  console.log(`[probe] params = ${JSON.stringify(params)}`);

  const execution_id = await executeQuery(GAUNTLET_QUERY_ID, params);
  console.log(`[probe] execution_id = ${execution_id}`);

  const maxWaitSec = 600;
  const start = Date.now();
  while (true) {
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed > maxWaitSec) {
      console.error(`[probe] timeout after ${elapsed}s`);
      exit(1);
    }
    const { state, raw } = await getStatus(execution_id);
    console.log(`[probe] +${elapsed}s state=${state}`);
    if (state === 'QUERY_STATE_COMPLETED') break;
    if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') {
      console.error('[probe] query failed', raw);
      exit(1);
    }
    await sleep(5000);
  }

  const rows = await getResults(execution_id);
  console.log(`[probe] total rows = ${rows.length}`);

  if (rows.length === 0) {
    console.log('[probe] empty result — query may need different params or vault has no holders yet');
    return;
  }

  // schema dump
  console.log('[probe] sample row[0] keys:', Object.keys(rows[0]));
  console.log('[probe] sample row[0]:', JSON.stringify(rows[0], null, 2));

  // 9.1.3: 最古 / 最新 snapshot_date
  const dates = rows
    .map((r) => r.snapshot_date)
    .filter(Boolean)
    .sort();
  console.log(`[probe] snapshot_date range: ${dates[0]} .. ${dates[dates.length - 1]}`);
  const uniqueDates = new Set(dates.map((d) => String(d).slice(0, 10)));
  console.log(`[probe] unique snapshot_date count: ${uniqueDates.size}`);

  // 9.1.1: probe wallet 最新値
  const probeRows = rows.filter(
    (r) => String(r.holder_address ?? '').toLowerCase() === PROBE_WALLET.toLowerCase(),
  );
  console.log(`[probe] rows for ${PROBE_WALLET}: ${probeRows.length}`);
  if (probeRows.length > 0) {
    probeRows.sort((a, b) => (a.snapshot_date < b.snapshot_date ? 1 : -1));
    const latest = probeRows[0];
    console.log('[probe] latest probe wallet row:', JSON.stringify(latest, null, 2));
    console.log(`[probe] gtusda_balance (raw) = ${latest.gtusda_balance}`);
    console.log(
      `[probe] >>> KASTアプリ表示額と上記値を比較し、shares か USD 換算かを判断 <<<`,
    );
  }

  // 最新日の TVL 合計（USD 仮定で集計）
  const latestDate = dates[dates.length - 1];
  const latestRows = rows.filter((r) => r.snapshot_date === latestDate);
  const sumBalance = latestRows.reduce(
    (acc, r) => acc + Number(r.gtusda_balance ?? 0),
    0,
  );
  console.log(`[probe] latest date ${latestDate}: ${latestRows.length} holders, sum gtusda_balance = ${sumBalance.toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

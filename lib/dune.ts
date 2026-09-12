import { env } from 'node:process';

const DUNE_API = 'https://api.dune.com/api/v1';

export const GAUNTLET_SNAPSHOTS_QUERY_ID = 7534621;
export const GAUNTLET_PRICE_QUERY_ID = 7543001;
export const KAST_BASE_WALLETS_QUERY_ID = 7544316;

export const GAUNTLET_VAULT = '0x000000000001CdB57E58Fa75Fe420a0f4D6640D5';
export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const KAST_ONRAMP = '0x5E690CFd5598F8d0E335b96e9F2f1b1527b7a5bF';

export type DuneExecutionState =
  | 'QUERY_STATE_PENDING'
  | 'QUERY_STATE_EXECUTING'
  | 'QUERY_STATE_COMPLETED'
  | 'QUERY_STATE_FAILED'
  | 'QUERY_STATE_CANCELLED';

function headers(): Record<string, string> {
  const key = env.DUNE_API_KEY;
  if (!key) throw new Error('DUNE_API_KEY not set');
  return {
    'X-Dune-API-Key': key,
    'Content-Type': 'application/json',
  };
}

export async function executeQuery(
  queryId: number,
  params: Record<string, string>,
): Promise<string> {
  const res = await fetch(`${DUNE_API}/query/${queryId}/execute`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query_parameters: params }),
  });
  if (!res.ok) {
    throw new Error(`Dune execute failed: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as { execution_id: string };
  return j.execution_id;
}

export async function getExecutionStatus(
  executionId: string,
): Promise<{ state: DuneExecutionState; raw: unknown }> {
  const res = await fetch(`${DUNE_API}/execution/${executionId}/status`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`Dune status failed: ${res.status}`);
  const j = (await res.json()) as { state: DuneExecutionState };
  return { state: j.state, raw: j };
}

export async function getExecutionResults<T = Record<string, unknown>>(
  executionId: string,
): Promise<T[]> {
  const res = await fetch(`${DUNE_API}/execution/${executionId}/results`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`Dune results failed: ${res.status}`);
  const j = (await res.json()) as { result: { rows: T[] } };
  return j.result.rows;
}

/**
 * `/results` をページングしながら全行取得する。
 * `getExecutionResults` は 1 リクエストで取り切る前提なので、
 * 10 万行級の backfill（Phase 17.2）ではこちらを使う。
 * ページを分けても取得 datapoint 数は変わらないのでクレジット消費は同じ。
 */
export async function getAllExecutionResults<T = Record<string, unknown>>(
  executionId: string,
  opts: { pageSize?: number; onPage?: (fetched: number, total: number | null) => void } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 25_000;
  const all: T[] = [];
  let offset = 0;
  let total: number | null = null;

  for (;;) {
    const url = `${DUNE_API}/execution/${executionId}/results?limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`Dune results failed: ${res.status} ${await res.text()}`);
    const j = (await res.json()) as {
      result?: { rows?: T[]; metadata?: { total_row_count?: number } };
      next_offset?: number;
    };

    const rows = j.result?.rows ?? [];
    for (const r of rows) all.push(r);
    total = j.result?.metadata?.total_row_count ?? total;
    opts.onPage?.(all.length, total);

    if (typeof j.next_offset === 'number' && rows.length > 0) offset = j.next_offset;
    else break;
  }

  return all;
}

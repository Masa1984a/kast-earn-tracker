'use client';

import { useEffect, useState } from 'react';

const DUNE_API = 'https://api.dune.com/api/v1';
const SESSION_KEY = 'dune_api_key';

const QUERIES = [
  { id: 7534621, label: 'Vault holders (gauntlet_snapshots)' },
  { id: 7543001, label: 'Share price + enter events (gauntlet_share_prices)' },
  { id: 7544316, label: 'KAST identified wallets (Bybit OTC funded)' },
] as const;

type QueryId = (typeof QUERIES)[number]['id'];

interface DuneRow {
  [key: string]: unknown;
}

interface DuneResponse {
  execution_id?: string;
  query_id?: number;
  state?: string;
  submitted_at?: string;
  execution_started_at?: string;
  execution_ended_at?: string;
  result?: {
    rows: DuneRow[];
    metadata: { column_names: string[] };
  };
}

async function fetchDuneLatest(
  apiKey: string,
  queryId: number,
  limit: number,
): Promise<DuneResponse> {
  const res = await fetch(`${DUNE_API}/query/${queryId}/results?limit=${limit}`, {
    method: 'GET',
    headers: { 'X-Dune-API-Key': apiKey },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: string };
      detail = j.error ?? '';
    } catch {
      // ignore
    }
    throw new Error(`Dune HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await res.json()) as DuneResponse;
}

function formatCell(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString('en-US', { maximumFractionDigits: 6 });
  }
  if (typeof value === 'string') {
    const asNum = Number(value);
    if (
      value.length > 0 &&
      Number.isFinite(asNum) &&
      /^-?\d+(?:\.\d+)?$/.test(value)
    ) {
      return Number.isInteger(asNum)
        ? asNum.toLocaleString()
        : asNum.toLocaleString('en-US', { maximumFractionDigits: 6 });
    }
    return value;
  }
  return String(value);
}

export default function GauntletDuneView() {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [queryId, setQueryId] = useState<QueryId>(QUERIES[0].id);
  const [limit, setLimit] = useState<number>(100);
  const [result, setResult] = useState<DuneResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const k = window.sessionStorage.getItem(SESSION_KEY);
    if (k) setApiKey(k);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (apiKey) window.sessionStorage.setItem(SESSION_KEY, apiKey);
  }, [apiKey]);

  const handleFetch = async () => {
    setErr(null);
    setResult(null);
    setRunning(true);
    try {
      const key = apiKey.trim();
      if (!key) throw new Error('Dune API key is required');
      const safeLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
      const res = await fetchDuneLatest(key, queryId, safeLimit);
      setResult(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const handleClearKey = () => {
    setApiKey('');
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(SESSION_KEY);
    }
  };

  const columns = result?.result?.metadata?.column_names ?? [];
  const rows = result?.result?.rows ?? [];

  return (
    <div>
      <p className="text-sm text-[#4C566A] dark:text-[#D8DEE9]">
        Run the Dune queries this dashboard relies on with your own Dune API key. The key is kept
        only in <code>sessionStorage</code> and sent directly to{' '}
        <code>api.dune.com</code> — it never reaches this site&apos;s backend.
      </p>

      <div className="mt-4 space-y-3 rounded-md border border-[#D8DEE9] bg-[#E5E9F0] p-3 shadow-sm dark:border-[#434C5E] dark:bg-[#3B4252]">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex flex-1 min-w-[260px] items-center gap-2">
            <span className="text-xs text-[#4C566A] dark:text-[#D8DEE9]">Dune API key</span>
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="dQB..."
              autoComplete="off"
              spellCheck={false}
              className="flex-1 rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 font-mono text-xs text-[#2E3440] focus:border-[#5E81AC] focus:outline-none dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4]"
            />
          </label>
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 text-xs text-[#2E3440] hover:bg-[#D8DEE9] dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4] dark:hover:bg-[#4C566A]"
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            onClick={handleClearKey}
            className="rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 text-xs text-[#2E3440] hover:bg-[#D8DEE9] dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4] dark:hover:bg-[#4C566A]"
          >
            Clear
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-xs text-[#4C566A] dark:text-[#D8DEE9]">Query</span>
            <select
              value={queryId}
              onChange={(e) => setQueryId(Number(e.target.value) as QueryId)}
              className="rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 text-xs text-[#2E3440] focus:border-[#5E81AC] focus:outline-none dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4]"
            >
              {QUERIES.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.id} — {q.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-xs text-[#4C566A] dark:text-[#D8DEE9]">Limit</span>
            <input
              type="number"
              min={1}
              max={10000}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-24 rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 text-xs text-[#2E3440] focus:border-[#5E81AC] focus:outline-none dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4]"
            />
          </label>
          <button
            type="button"
            onClick={handleFetch}
            disabled={running}
            className="rounded bg-[#5E81AC] px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-[#81A1C1] disabled:opacity-50 dark:bg-[#5E81AC] dark:hover:bg-[#81A1C1]"
          >
            {running ? 'Fetching…' : 'Fetch latest results'}
          </button>
          <a
            href={`https://dune.com/queries/${queryId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[#5E81AC] hover:underline dark:text-[#88C0D0]"
          >
            Open query on Dune ↗
          </a>
        </div>
      </div>

      {err && (
        <p className="mt-4 rounded border border-[#BF616A] bg-[#BF616A]/10 p-3 text-sm text-[#BF616A]">
          {err}
        </p>
      )}

      {result && (
        <div className="mt-4 overflow-hidden rounded-md border border-[#D8DEE9] bg-[#ECEFF4] shadow-sm dark:border-[#434C5E] dark:bg-[#3B4252]">
          <div className="flex flex-wrap items-center gap-3 border-b border-[#D8DEE9] bg-[#E5E9F0] px-3 py-1.5 text-xs text-[#4C566A] dark:border-[#434C5E] dark:bg-[#434C5E] dark:text-[#D8DEE9]">
            <span>
              Rows: <strong>{rows.length.toLocaleString()}</strong>
            </span>
            {result.execution_ended_at && (
              <span>
                Executed: <strong>{result.execution_ended_at}</strong>
              </span>
            )}
            {result.state && (
              <span>
                State: <strong>{result.state}</strong>
              </span>
            )}
          </div>
          <div className="max-h-[600px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#E5E9F0] text-[#2E3440] dark:bg-[#434C5E] dark:text-[#ECEFF4]">
                <tr>
                  {columns.map((c) => (
                    <th key={c} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={columns.length || 1}
                      className="px-2 py-3 text-center text-[#4C566A] dark:text-[#D8DEE9]"
                    >
                      No rows
                    </td>
                  </tr>
                )}
                {rows.map((row, i) => (
                  <tr
                    key={i}
                    className="border-t border-[#D8DEE9]/60 hover:bg-[#E5E9F0] dark:border-[#434C5E] dark:hover:bg-[#434C5E]"
                  >
                    {columns.map((c) => (
                      <td
                        key={c}
                        className="px-2 py-1 font-mono whitespace-nowrap"
                      >
                        {formatCell(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

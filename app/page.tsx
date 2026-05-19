'use client';

import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const SIZE_BUCKETS = [
  'dust_lt_100',
  'retail_100_1k',
  'mid_1k_10k',
  'large_10k_100k',
  'whale_100k+',
] as const;
type SizeBucket = (typeof SIZE_BUCKETS)[number];

const BUCKET_COLOR: Record<SizeBucket, string> = {
  'whale_100k+': '#dc2626',
  large_10k_100k: '#ea580c',
  mid_1k_10k: '#facc15',
  retail_100_1k: '#65a30d',
  dust_lt_100: '#94a3b8',
};
const BUCKET_LABEL: Record<SizeBucket, string> = {
  'whale_100k+': 'Whale ($100k+)',
  large_10k_100k: 'Large ($10k–100k)',
  mid_1k_10k: 'Mid ($1k–10k)',
  retail_100_1k: 'Retail ($100–1k)',
  dust_lt_100: 'Dust (<$100)',
};

// All known non-KAST-custodial labels — collapsed into a single "Has SOL" toggle
// because the unifying property is "the wallet has SOL = it's not a KAST custodial user".
const NON_CUSTODIAL_LABELS = 'treasury,infra,has_sol';

interface Summary {
  snapshot_date: string | null;
  holders: number;
  total_usd: number;
  multiplier: number;
}
type SeriesPoint = { date: string } & Partial<Record<SizeBucket, number>>;

export default function Home() {
  // Default OFF = exclude non-custodial wallets, showing pure KAST users only.
  const [showHasSol, setShowHasSol] = useState<boolean>(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [series, setSeries] = useState<SeriesPoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const excludeParam = showHasSol ? '' : NON_CUSTODIAL_LABELS;

  useEffect(() => {
    setLoading(true);
    setErr(null);
    const qs = excludeParam ? `?exclude=${excludeParam}` : '';
    Promise.all([
      fetch(`/api/summary${qs}`).then((r) => r.json()),
      fetch(`/api/snapshots${excludeParam ? `?bucket=size&exclude=${excludeParam}` : '?bucket=size'}`).then(
        (r) => r.json(),
      ),
    ])
      .then(([s, p]) => {
        setSummary(s as Summary);
        setSeries(p as SeriesPoint[]);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [excludeParam]);

  return (
    <main className="min-h-screen bg-neutral-50 p-4 text-neutral-900 sm:p-8 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-6xl">
        <header>
          <h1 className="text-2xl font-bold sm:text-3xl">USDKY Holders Tracker</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Daily principal × multiplier snapshot of USDKY holders, bucketed by USD value.
          </p>
        </header>

        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-md bg-white p-3 shadow dark:bg-neutral-900">
          <label className="flex cursor-pointer items-center gap-3 select-none">
            <button
              type="button"
              role="switch"
              aria-checked={showHasSol}
              onClick={() => setShowHasSol((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                showHasSol ? 'bg-blue-600' : 'bg-neutral-300 dark:bg-neutral-700'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  showHasSol ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <span className="text-sm">
              Has SOL{' '}
              <span className="text-xs text-neutral-500">
                {showHasSol ? '(included)' : '(excluded — KAST users only)'}
              </span>
            </span>
          </label>
          {loading && <span className="ml-auto text-xs text-neutral-500">loading…</span>}
        </div>

        {summary && (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Snapshot date" value={summary.snapshot_date ?? '—'} />
            <Stat label="Holders" value={summary.holders.toLocaleString()} />
            <Stat
              label="Total USD"
              value={`$${Math.round(summary.total_usd).toLocaleString()}`}
            />
            <Stat label="Multiplier" value={summary.multiplier.toFixed(6)} />
          </div>
        )}

        {err && (
          <p className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {err}
          </p>
        )}

        {series && series.length > 0 && (
          <div className="mt-6 h-[480px] rounded-md bg-white p-4 shadow sm:h-[520px] dark:bg-neutral-900">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                <CartesianGrid stroke="#e5e7eb" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) =>
                    v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : `$${(v / 1000).toFixed(0)}k`
                  }
                />
                <Tooltip
                  formatter={(v, name) => [
                    `$${Math.round(Number(v ?? 0)).toLocaleString()}`,
                    String(name ?? ''),
                  ]}
                />
                <Legend />
                {SIZE_BUCKETS.map((b) => (
                  <Bar
                    key={b}
                    dataKey={b}
                    stackId="size"
                    fill={BUCKET_COLOR[b]}
                    name={BUCKET_LABEL[b]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {series && series.length === 0 && (
          <p className="mt-6 text-neutral-500">No snapshot data — run the backfill first.</p>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-white p-3 shadow dark:bg-neutral-900">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 font-mono text-base sm:text-lg">{value}</div>
    </div>
  );
}

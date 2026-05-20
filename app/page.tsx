'use client';

import { useEffect, useMemo, useState } from 'react';
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

const SERVICE_COLOR = {
  usdky: '#2563eb',
  gauntlet: '#7c3aed',
} as const;

type Service = 'all' | 'usdky' | 'gauntlet';

interface UsdkySummary {
  snapshot_date: string | null;
  holders: number;
  total_usd: number;
  multiplier: number;
}
interface GauntletSummary {
  snapshot_date: string | null;
  holders: number;
  total_usd: number;
  share_price: number;
}
interface SummaryResponse {
  usdky: UsdkySummary;
  gauntlet: GauntletSummary;
  kast_only: boolean;
}

type SizePoint = { date: string } & Partial<Record<SizeBucket, number>>;
type ServicePoint = { date: string; usdky: number; gauntlet: number };
type SeriesPoint = SizePoint | ServicePoint;

interface SharePricePoint {
  date: string;
  share_price: number;
  enter_events_today: number;
  daily_volume_usdc: number;
}

function computeAnnualizedYield(points: SharePricePoint[], days = 30): number | null {
  if (points.length < 2) return null;
  const recent = points.slice(-days);
  if (recent.length < 2) return null;
  const startPrice = recent[0].share_price;
  const endPrice = recent[recent.length - 1].share_price;
  if (startPrice <= 0) return null;
  const period = recent.length - 1;
  return Math.pow(endPrice / startPrice, 365 / period) - 1;
}

const KAST_INFO_TEXT = `KAST users are identified by service-specific on-chain signatures:
• USDKY (Solana): wallets without SOL balance (KAST sponsors gas, so KAST users typically don't hold SOL)
• Gauntlet Alpha (Base): wallets whose first USDC funding came from KAST's Bybit OTC onramp
Coverage estimate: ~95% of USDKY holders, ~68% of Gauntlet holders.`;

export default function Home() {
  const [service, setService] = useState<Service>('all');
  const [kastOnly, setKastOnly] = useState<boolean>(true);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [series, setSeries] = useState<SeriesPoint[] | null>(null);
  const [sharePrices, setSharePrices] = useState<SharePricePoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    setLoading(true);
    setErr(null);

    const summaryQs = new URLSearchParams();
    if (kastOnly) summaryQs.set('kast_only', 'true');
    const snapshotsQs = new URLSearchParams({ bucket: 'size' });
    if (service !== 'all') snapshotsQs.set('service', service);
    if (kastOnly) snapshotsQs.set('kast_only', 'true');

    Promise.all([
      fetch(`/api/summary?${summaryQs.toString()}`).then((r) => r.json()),
      fetch(`/api/snapshots?${snapshotsQs.toString()}`).then((r) => r.json()),
      fetch('/api/share-prices?service=gauntlet').then((r) => r.json()),
    ])
      .then(([s, p, sp]) => {
        setSummary(s as SummaryResponse);
        setSeries(p as SeriesPoint[]);
        setSharePrices(sp as SharePricePoint[]);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [kastOnly, service]);

  const annualizedYield = useMemo(
    () => (sharePrices ? computeAnnualizedYield(sharePrices) : null),
    [sharePrices],
  );

  return (
    <main className="min-h-screen bg-neutral-50 p-4 text-neutral-900 sm:p-8 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-6xl">
        <header>
          <h1 className="text-2xl font-bold sm:text-3xl">KAST Earn Tracker</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Daily TVL snapshot across USDKY (Solana) and Gauntlet Alpha Vault (Base).
          </p>
        </header>

        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-md bg-white p-3 shadow dark:bg-neutral-900">
          <div className="inline-flex overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700">
            {(['all', 'usdky', 'gauntlet'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setService(s)}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  service === s
                    ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                    : 'bg-white text-neutral-700 hover:bg-neutral-50 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800'
                }`}
              >
                {s === 'all' ? 'All' : s === 'usdky' ? 'USDKY' : 'Gauntlet Alpha'}
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-3 select-none">
            <button
              type="button"
              role="switch"
              aria-checked={kastOnly}
              onClick={() => setKastOnly((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                kastOnly ? 'bg-blue-600' : 'bg-neutral-300 dark:bg-neutral-700'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  kastOnly ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <span className="flex items-center gap-1.5 text-sm">
              KAST users only
              <span
                className="cursor-help text-xs text-neutral-400"
                title={KAST_INFO_TEXT}
                aria-label="KAST identification details"
              >
                ⓘ
              </span>
            </span>
          </label>
          {loading && <span className="ml-auto text-xs text-neutral-500">loading…</span>}
        </div>

        {summary && (
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {(service === 'all' || service === 'usdky') && (
              <ServiceCard
                title="USDKY"
                accent="bg-blue-600"
                rows={[
                  ['Snapshot date', summary.usdky.snapshot_date ?? '—'],
                  ['Holders', summary.usdky.holders.toLocaleString()],
                  ['Total USD', `$${Math.round(summary.usdky.total_usd).toLocaleString()}`],
                  ['Multiplier', summary.usdky.multiplier.toFixed(6)],
                ]}
                note={kastOnly ? 'Filtered: wallets without SOL balance' : null}
              />
            )}
            {(service === 'all' || service === 'gauntlet') && (
              <ServiceCard
                title="Gauntlet Alpha"
                accent="bg-violet-600"
                rows={[
                  ['Snapshot date', summary.gauntlet.snapshot_date ?? '—'],
                  ['Holders', summary.gauntlet.holders.toLocaleString()],
                  ['Total USD', `$${Math.round(summary.gauntlet.total_usd).toLocaleString()}`],
                  ['Share price', summary.gauntlet.share_price.toFixed(6)],
                  [
                    'Annualized yield (30d)',
                    annualizedYield == null ? '—' : `${(annualizedYield * 100).toFixed(2)}%`,
                  ],
                ]}
                note={
                  kastOnly ? 'Filtered: wallets first funded via Bybit OTC' : null
                }
              />
            )}
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
                    v >= 1_000_000
                      ? `$${(v / 1_000_000).toFixed(1)}M`
                      : `$${(v / 1000).toFixed(0)}k`
                  }
                />
                <Tooltip
                  formatter={(v, name) => [
                    `$${Math.round(Number(v ?? 0)).toLocaleString()}`,
                    String(name ?? ''),
                  ]}
                />
                <Legend />
                {service === 'all' ? (
                  <>
                    <Bar
                      dataKey="usdky"
                      stackId="service"
                      fill={SERVICE_COLOR.usdky}
                      name="USDKY"
                    />
                    <Bar
                      dataKey="gauntlet"
                      stackId="service"
                      fill={SERVICE_COLOR.gauntlet}
                      name="Gauntlet Alpha"
                    />
                  </>
                ) : (
                  SIZE_BUCKETS.map((b) => (
                    <Bar
                      key={b}
                      dataKey={b}
                      stackId="size"
                      fill={BUCKET_COLOR[b]}
                      name={BUCKET_LABEL[b]}
                    />
                  ))
                )}
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

function ServiceCard({
  title,
  accent,
  rows,
  note,
}: {
  title: string;
  accent: string;
  rows: Array<[string, string]>;
  note: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-md bg-white shadow dark:bg-neutral-900">
      <div className={`${accent} px-3 py-1.5 text-sm font-semibold text-white`}>{title}</div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
            <dd className="mt-1 font-mono text-sm sm:text-base">{value}</dd>
          </div>
        ))}
      </dl>
      {note && (
        <div className="border-t border-neutral-100 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800">
          ※ {note}
        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
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

// Nord palette (daisyUI nord theme)
const NORD = {
  polar0: '#2E3440',
  polar1: '#3B4252',
  polar2: '#434C5E',
  polar3: '#4C566A',
  snow0: '#D8DEE9',
  snow1: '#E5E9F0',
  snow2: '#ECEFF4',
  frost0: '#8FBCBB',
  frost1: '#88C0D0',
  frost2: '#81A1C1',
  frost3: '#5E81AC',
  red: '#BF616A',
  orange: '#D08770',
  yellow: '#EBCB8B',
  green: '#A3BE8C',
  purple: '#B48EAD',
} as const;

const BUCKET_COLOR: Record<SizeBucket, string> = {
  dust_lt_100: NORD.frost1,
  retail_100_1k: NORD.green,
  mid_1k_10k: NORD.yellow,
  large_10k_100k: NORD.orange,
  'whale_100k+': NORD.red,
};
const BUCKET_LABEL: Record<SizeBucket, string> = {
  'whale_100k+': 'Whale ($100k+)',
  large_10k_100k: 'Large ($10k–100k)',
  mid_1k_10k: 'Mid ($1k–10k)',
  retail_100_1k: 'Retail ($100–1k)',
  dust_lt_100: 'Dust (<$100)',
};

const SERVICE_COLOR = {
  usdky: NORD.frost3,
  gauntlet: NORD.purple,
} as const;

const HOLDERS_LINE_COLOR = {
  usdky: NORD.polar1,
  gauntlet: NORD.orange,
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

type SizePoint = { date: string; holders: number } & Partial<Record<SizeBucket, number>>;
type ServicePoint = {
  date: string;
  usdky: number;
  gauntlet: number;
  usdky_holders: number;
  gauntlet_holders: number;
};
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

function isHolderSeries(name: unknown): boolean {
  const s = String(name);
  return s.includes('holders') || s.endsWith('Holders');
}

function formatTooltip(value: number | string, name: string): [string, string] {
  const num = Number(value ?? 0);
  if (isHolderSeries(name)) {
    return [num.toLocaleString(), name];
  }
  return [`$${Math.round(num).toLocaleString()}`, name];
}

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
    <main className="min-h-screen bg-[#ECEFF4] p-4 text-[#2E3440] sm:p-8 dark:bg-[#2E3440] dark:text-[#ECEFF4]">
      <div className="mx-auto max-w-6xl">
        <header>
          <h1 className="text-2xl font-bold sm:text-3xl">KAST Earn Tracker</h1>
          <p className="mt-1 text-sm text-[#4C566A] dark:text-[#D8DEE9]">
            Daily TVL snapshot across USDKY (Solana) and Gauntlet Alpha Vault (Base).
          </p>
        </header>

        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-md border border-[#D8DEE9] bg-[#E5E9F0] p-3 shadow-sm dark:border-[#434C5E] dark:bg-[#3B4252]">
          <div className="inline-flex overflow-hidden rounded-md border border-[#D8DEE9] dark:border-[#4C566A]">
            {(['all', 'usdky', 'gauntlet'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setService(s)}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  service === s
                    ? 'bg-[#5E81AC] text-white'
                    : 'bg-[#ECEFF4] text-[#2E3440] hover:bg-[#D8DEE9] dark:bg-[#434C5E] dark:text-[#ECEFF4] dark:hover:bg-[#4C566A]'
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
                kastOnly ? 'bg-[#5E81AC]' : 'bg-[#D8DEE9] dark:bg-[#4C566A]'
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
                className="cursor-help text-xs text-[#4C566A] dark:text-[#D8DEE9]"
                title={KAST_INFO_TEXT}
                aria-label="KAST identification details"
              >
                ⓘ
              </span>
            </span>
          </label>
          {loading && (
            <span className="ml-auto text-xs text-[#4C566A] dark:text-[#D8DEE9]">loading…</span>
          )}
        </div>

        {summary && (
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {(service === 'all' || service === 'usdky') && (
              <ServiceCard
                title="USDKY"
                accentBg="bg-[#5E81AC]"
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
                accentBg="bg-[#B48EAD]"
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
                note={kastOnly ? 'Filtered: wallets first funded via Bybit OTC' : null}
              />
            )}
          </div>
        )}

        {err && (
          <p className="mt-4 rounded border border-[#BF616A] bg-[#BF616A]/10 p-3 text-sm text-[#BF616A]">
            {err}
          </p>
        )}

        {series && series.length > 0 && (
          <div className="mt-6 h-[480px] rounded-md border border-[#D8DEE9] bg-[#ECEFF4] p-4 shadow-sm sm:h-[520px] dark:border-[#434C5E] dark:bg-[#3B4252]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={series} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                <CartesianGrid stroke={NORD.snow0} strokeOpacity={0.6} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: NORD.polar3 }}
                  stroke={NORD.polar3}
                  interval="preserveStartEnd"
                />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 11, fill: NORD.polar3 }}
                  stroke={NORD.polar3}
                  tickFormatter={(v: number) =>
                    v >= 1_000_000
                      ? `$${(v / 1_000_000).toFixed(1)}M`
                      : `$${(v / 1000).toFixed(0)}k`
                  }
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 11, fill: NORD.polar3 }}
                  stroke={NORD.polar3}
                  tickFormatter={(v: number) =>
                    v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
                  }
                  label={{
                    value: 'Holders',
                    angle: 90,
                    position: 'insideRight',
                    fill: NORD.polar3,
                    fontSize: 11,
                    offset: -2,
                  }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: NORD.snow2,
                    border: `1px solid ${NORD.snow0}`,
                    borderRadius: 6,
                    color: NORD.polar0,
                  }}
                  labelStyle={{ color: NORD.polar0, fontWeight: 600 }}
                  itemStyle={{ color: NORD.polar0 }}
                  cursor={{ fill: NORD.snow0, opacity: 0.5 }}
                  formatter={(v, name) => formatTooltip(v as number, String(name))}
                />
                <Legend wrapperStyle={{ color: NORD.polar3, fontSize: 12 }} />
                {service === 'all' ? (
                  <>
                    <Bar
                      yAxisId="left"
                      dataKey="usdky"
                      stackId="service"
                      fill={SERVICE_COLOR.usdky}
                      name="USDKY"
                    />
                    <Bar
                      yAxisId="left"
                      dataKey="gauntlet"
                      stackId="service"
                      fill={SERVICE_COLOR.gauntlet}
                      name="Gauntlet Alpha"
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="usdky_holders"
                      stroke={HOLDERS_LINE_COLOR.usdky}
                      strokeWidth={2}
                      dot={false}
                      name="USDKY holders"
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="gauntlet_holders"
                      stroke={HOLDERS_LINE_COLOR.gauntlet}
                      strokeWidth={2}
                      dot={false}
                      name="Gauntlet holders"
                    />
                  </>
                ) : (
                  <>
                    {SIZE_BUCKETS.map((b) => (
                      <Bar
                        key={b}
                        yAxisId="left"
                        dataKey={b}
                        stackId="size"
                        fill={BUCKET_COLOR[b]}
                        name={BUCKET_LABEL[b]}
                      />
                    ))}
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="holders"
                      stroke={
                        service === 'usdky' ? HOLDERS_LINE_COLOR.usdky : HOLDERS_LINE_COLOR.gauntlet
                      }
                      strokeWidth={2}
                      dot={false}
                      name={service === 'usdky' ? 'USDKY holders' : 'Gauntlet holders'}
                    />
                  </>
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        {series && series.length === 0 && (
          <p className="mt-6 text-[#4C566A] dark:text-[#D8DEE9]">
            No snapshot data — run the backfill first.
          </p>
        )}
      </div>
    </main>
  );
}

function ServiceCard({
  title,
  accentBg,
  rows,
  note,
}: {
  title: string;
  accentBg: string;
  rows: Array<[string, string]>;
  note: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-[#D8DEE9] bg-[#ECEFF4] shadow-sm dark:border-[#434C5E] dark:bg-[#3B4252]">
      <div className={`${accentBg} px-3 py-1.5 text-sm font-semibold text-white`}>{title}</div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs uppercase tracking-wide text-[#4C566A] dark:text-[#D8DEE9]">
              {label}
            </dt>
            <dd className="mt-1 font-mono text-sm text-[#2E3440] sm:text-base dark:text-[#ECEFF4]">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {note && (
        <div className="border-t border-[#D8DEE9] px-3 py-1.5 text-xs text-[#4C566A] dark:border-[#434C5E] dark:text-[#D8DEE9]">
          ※ {note}
        </div>
      )}
    </div>
  );
}

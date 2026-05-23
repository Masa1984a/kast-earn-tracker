'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
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

const KAST_CTA_URL = 'https://go.kast.xyz/VqVO/SAPPORO';

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

// Holders lines: vivid primaries so they pop on top of the Nord-toned bars.
const HOLDERS_LINE_COLOR = {
  usdky: '#2563EB',
  gauntlet: '#DC2626',
} as const;

type Service = 'all' | 'usdky' | 'gauntlet';

interface UsdkySummary {
  snapshot_date: string | null;
  snapshot_at: string | null;
  holders: number;
  total_usd: number;
  multiplier: number;
}
interface GauntletSummary {
  snapshot_date: string | null;
  snapshot_at: string | null;
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

interface UsdkyHolderRow {
  wallet: string;
  usd_value: number;
  principal: number;
  multiplier: number;
}
interface GauntletHolderRow {
  wallet: string;
  usd_value: number;
  shares: number;
  share_price: number;
}
interface HoldersResponse<T> {
  service: 'usdky' | 'gauntlet';
  snapshot_date: string | null;
  total: number;
  holders: T[];
}

const HOLDERS_LIMIT = 100;

function computeAnnualizedYield(points: SharePricePoint[], days = 7): number | null {
  if (points.length < 2) return null;
  const recent = points.slice(-days);
  if (recent.length < 2) return null;
  const startPrice = recent[0].share_price;
  const endPrice = recent[recent.length - 1].share_price;
  if (startPrice <= 0) return null;
  const startMs = Date.parse(recent[0].date);
  const endMs = Date.parse(recent[recent.length - 1].date);
  const periodDays = (endMs - startMs) / 86_400_000;
  if (!Number.isFinite(periodDays) || periodDays <= 0) return null;
  return Math.pow(endPrice / startPrice, 365 / periodDays) - 1;
}

function formatSnapshotAt(iso: string | null, fallbackDate: string | null): string {
  if (!iso) return fallbackDate ?? '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallbackDate ?? iso;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} UTC`;
}

function fillDailyCarryForward(points: SharePricePoint[]): SharePricePoint[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map(sorted.map((p) => [p.date, p] as const));
  const startMs = Date.parse(sorted[0].date);
  const endMs = Date.parse(sorted[sorted.length - 1].date);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return sorted;
  const out: SharePricePoint[] = [];
  let lastPoint = sorted[0];
  for (let t = startMs; t <= endMs; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const hit = byDate.get(d);
    if (hit != null) lastPoint = hit;
    out.push({ ...lastPoint, date: d });
  }
  return out;
}

function computeRollingYieldSeries(
  points: SharePricePoint[],
  windowDays = 7,
): { date: string; annualized_yield: number | null }[] {
  return points.map((p, i) => {
    if (i + 1 < windowDays) return { date: p.date, annualized_yield: null };
    const startP = points[i + 1 - windowDays];
    if (startP.share_price <= 0) return { date: p.date, annualized_yield: null };
    const periodDays = (Date.parse(p.date) - Date.parse(startP.date)) / 86_400_000;
    if (!Number.isFinite(periodDays) || periodDays <= 0) {
      return { date: p.date, annualized_yield: null };
    }
    const y = Math.pow(p.share_price / startP.share_price, 365 / periodDays) - 1;
    return { date: p.date, annualized_yield: y };
  });
}

const KAST_INFO_TEXT = `KAST users are identified by service-specific on-chain signatures:
• USDKY (Solana): wallets without SOL balance (KAST sponsors gas, so KAST users typically don't hold SOL)
• Gauntlet Alpha (Base): wallets whose first USDC funding came from KAST's Bybit OTC onramp
Coverage estimate: ~95% of USDKY holders, ~68% of Gauntlet holders.`;

const YIELD_CARD_INFO_TEXT = `Yield (7D): the most recent 7 daily share_price points, annualized.
Formula: (price[latest] / price[7 days earlier])^(365 / actual_days) - 1
share_price source — USDKY: Token2022 scaledUiAmount multiplier. Gauntlet: vault share price from Dune.`;

const YIELD_CHART_INFO_TEXT = `For each date d, plots the annualized return over the trailing 7 days ending on d.
Formula: (price[d] / price[d-6])^(365 / actual_days) - 1
USDKY days without an on-chain multiplier update are filled by carrying the previous day's value forward so the line stays continuous.`;

const DEFAULT_START_DATE = '2026-01-07';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  const [startDate, setStartDate] = useState<string>(DEFAULT_START_DATE);
  const [endDate, setEndDate] = useState<string>(() => todayISO());
  const [wallet, setWallet] = useState<string>('');
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [series, setSeries] = useState<SeriesPoint[] | null>(null);
  const [gauntletSharePrices, setGauntletSharePrices] = useState<SharePricePoint[] | null>(null);
  const [usdkySharePrices, setUsdkySharePrices] = useState<SharePricePoint[] | null>(null);
  const [usdkyHolders, setUsdkyHolders] = useState<HoldersResponse<UsdkyHolderRow> | null>(null);
  const [gauntletHolders, setGauntletHolders] = useState<HoldersResponse<GauntletHolderRow> | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const validRange = startDate <= endDate;

  useEffect(() => {
    if (!validRange) return;
    setLoading(true);
    setErr(null);

    const trimmedWallet = wallet.trim();

    const dateQs = (extra?: Record<string, string>) => {
      const qs = new URLSearchParams({ start_date: startDate, end_date: endDate, ...extra });
      if (kastOnly) qs.set('kast_only', 'true');
      if (trimmedWallet) qs.set('wallet', trimmedWallet);
      return qs;
    };

    const summaryQs = dateQs();
    const snapshotsQs = dateQs({ bucket: 'size' });
    if (service !== 'all') snapshotsQs.set('service', service);
    const gauntletPriceQs = new URLSearchParams({
      service: 'gauntlet',
      start_date: startDate,
      end_date: endDate,
    });
    const usdkyPriceQs = new URLSearchParams({
      service: 'usdky',
      start_date: startDate,
      end_date: endDate,
    });
    const holdersQs = (svc: 'usdky' | 'gauntlet') => {
      const qs = new URLSearchParams({
        service: svc,
        start_date: startDate,
        end_date: endDate,
        limit: String(HOLDERS_LIMIT),
      });
      if (kastOnly) qs.set('kast_only', 'true');
      if (trimmedWallet) qs.set('wallet', trimmedWallet);
      return qs;
    };

    Promise.all([
      fetch(`/api/summary?${summaryQs.toString()}`).then((r) => r.json()),
      fetch(`/api/snapshots?${snapshotsQs.toString()}`).then((r) => r.json()),
      fetch(`/api/share-prices?${gauntletPriceQs.toString()}`).then((r) => r.json()),
      fetch(`/api/share-prices?${usdkyPriceQs.toString()}`).then((r) => r.json()),
      fetch(`/api/holders?${holdersQs('usdky').toString()}`).then((r) => r.json()),
      fetch(`/api/holders?${holdersQs('gauntlet').toString()}`).then((r) => r.json()),
    ])
      .then(([s, p, gsp, usp, uh, gh]) => {
        setSummary(s as SummaryResponse);
        setSeries(p as SeriesPoint[]);
        setGauntletSharePrices(gsp as SharePricePoint[]);
        setUsdkySharePrices(usp as SharePricePoint[]);
        setUsdkyHolders(uh as HoldersResponse<UsdkyHolderRow>);
        setGauntletHolders(gh as HoldersResponse<GauntletHolderRow>);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [kastOnly, service, startDate, endDate, validRange, wallet]);

  const gauntletYield = useMemo(
    () => (gauntletSharePrices ? computeAnnualizedYield(gauntletSharePrices) : null),
    [gauntletSharePrices],
  );
  const usdkyYield = useMemo(
    () => (usdkySharePrices ? computeAnnualizedYield(usdkySharePrices) : null),
    [usdkySharePrices],
  );

  const yieldSeries = useMemo(() => {
    if (!usdkySharePrices && !gauntletSharePrices) return null;
    const usdkyFilled = usdkySharePrices ? fillDailyCarryForward(usdkySharePrices) : [];
    const gauntletFilled = gauntletSharePrices ? fillDailyCarryForward(gauntletSharePrices) : [];
    const usdkyMap = new Map(
      computeRollingYieldSeries(usdkyFilled).map(
        (p) => [p.date, p.annualized_yield] as const,
      ),
    );
    const gauntletMap = new Map(
      computeRollingYieldSeries(gauntletFilled).map(
        (p) => [p.date, p.annualized_yield] as const,
      ),
    );
    const dates = new Set<string>([...usdkyMap.keys(), ...gauntletMap.keys()]);
    return Array.from(dates)
      .sort()
      .map((date) => ({
        date,
        usdky_yield: usdkyMap.get(date) ?? null,
        gauntlet_yield: gauntletMap.get(date) ?? null,
      }));
  }, [usdkySharePrices, gauntletSharePrices]);

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
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-[#4C566A] dark:text-[#D8DEE9]">From</span>
              <input
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 text-xs text-[#2E3440] focus:border-[#5E81AC] focus:outline-none dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4] [color-scheme:light] dark:[color-scheme:dark]"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-[#4C566A] dark:text-[#D8DEE9]">To</span>
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 text-xs text-[#2E3440] focus:border-[#5E81AC] focus:outline-none dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4] [color-scheme:light] dark:[color-scheme:dark]"
              />
            </label>
          </div>
          <label className="flex items-center gap-1.5 text-sm">
            <span className="text-xs text-[#4C566A] dark:text-[#D8DEE9]">Wallet</span>
            <input
              type="text"
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              placeholder="0x… or Solana address"
              spellCheck={false}
              autoComplete="off"
              className="w-64 rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 font-mono text-xs text-[#2E3440] placeholder:text-[#9aa4b2] focus:border-[#5E81AC] focus:outline-none dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4] dark:placeholder:text-[#7b8595]"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setStartDate(DEFAULT_START_DATE);
              setEndDate(todayISO());
              setWallet('');
            }}
            className="rounded border border-[#D8DEE9] px-2 py-1 text-xs text-[#4C566A] hover:bg-[#D8DEE9] dark:border-[#4C566A] dark:text-[#D8DEE9] dark:hover:bg-[#4C566A]"
            aria-label="Reset filters to default"
          >
            Reset
          </button>
          {!validRange && (
            <span className="text-xs text-[#BF616A]">From must be ≤ To</span>
          )}
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
                  [
                    'Snapshot date',
                    formatSnapshotAt(summary.usdky.snapshot_at, summary.usdky.snapshot_date),
                  ],
                  ['Holders', summary.usdky.holders.toLocaleString()],
                  ['Total USD', `$${Math.round(summary.usdky.total_usd).toLocaleString()}`],
                  ['Share price', summary.usdky.multiplier.toFixed(6)],
                  [
                    <span key="yield-label" className="inline-flex items-center gap-1">
                      Yield (7D)
                      <span
                        className="cursor-help text-[10px] normal-case text-[#4C566A] dark:text-[#D8DEE9]"
                        title={YIELD_CARD_INFO_TEXT}
                        aria-label="Yield (7D) calculation details"
                      >
                        ⓘ
                      </span>
                    </span>,
                    usdkyYield == null ? '—' : `${(usdkyYield * 100).toFixed(2)}%`,
                  ],
                ]}
                note={kastOnly ? 'Filtered: wallets without SOL balance' : null}
              />
            )}
            {(service === 'all' || service === 'gauntlet') && (
              <ServiceCard
                title="Gauntlet Alpha"
                accentBg="bg-[#B48EAD]"
                rows={[
                  [
                    'Snapshot date',
                    formatSnapshotAt(
                      summary.gauntlet.snapshot_at,
                      summary.gauntlet.snapshot_date,
                    ),
                  ],
                  ['Holders', summary.gauntlet.holders.toLocaleString()],
                  ['Total USD', `$${Math.round(summary.gauntlet.total_usd).toLocaleString()}`],
                  ['Share price', summary.gauntlet.share_price.toFixed(6)],
                  [
                    <span key="yield-label" className="inline-flex items-center gap-1">
                      Yield (7D)
                      <span
                        className="cursor-help text-[10px] normal-case text-[#4C566A] dark:text-[#D8DEE9]"
                        title={YIELD_CARD_INFO_TEXT}
                        aria-label="Yield (7D) calculation details"
                      >
                        ⓘ
                      </span>
                    </span>,
                    gauntletYield == null ? '—' : `${(gauntletYield * 100).toFixed(2)}%`,
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
          <div className="mt-6 h-[480px] rounded-md border border-[#2E3440] bg-[#ECEFF4] p-4 shadow-sm sm:h-[520px] dark:border-[#ECEFF4] dark:bg-[#3B4252]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={series} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                <CartesianGrid stroke={NORD.snow0} strokeOpacity={0.6} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: 'var(--foreground)' }}
                  stroke="var(--foreground)"
                  interval="preserveStartEnd"
                />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 11, fill: 'var(--foreground)' }}
                  stroke="var(--foreground)"
                  tickFormatter={(v: number) =>
                    v >= 1_000_000
                      ? `$${(v / 1_000_000).toFixed(1)}M`
                      : `$${(v / 1000).toFixed(0)}k`
                  }
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 11, fill: 'var(--foreground)' }}
                  stroke="var(--foreground)"
                  tickFormatter={(v: number) =>
                    v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
                  }
                  label={{
                    value: 'Holders',
                    angle: 90,
                    position: 'insideRight',
                    fill: 'var(--foreground)',
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
                <Legend wrapperStyle={{ color: 'var(--foreground)', fontSize: 12 }} />
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

        {yieldSeries && yieldSeries.length > 0 && (
          <div className="mt-6 rounded-md border border-[#2E3440] bg-[#ECEFF4] p-4 shadow-sm dark:border-[#ECEFF4] dark:bg-[#3B4252]">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[#2E3440] dark:text-[#ECEFF4]">
              7-Day Rolling Annualized Yield
              <span
                className="cursor-help text-xs font-normal text-[#4C566A] dark:text-[#D8DEE9]"
                title={YIELD_CHART_INFO_TEXT}
                aria-label="Rolling yield chart calculation details"
              >
                ⓘ
              </span>
            </h3>
            <div className="h-[260px] sm:h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={yieldSeries}
                  margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                >
                  <CartesianGrid stroke={NORD.snow0} strokeOpacity={0.6} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: 'var(--foreground)' }}
                    stroke="var(--foreground)"
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--foreground)' }}
                    stroke="var(--foreground)"
                    tickFormatter={(v: number) => `${(v * 100).toFixed(1)}%`}
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
                    formatter={(v, name) => [
                      v == null ? '—' : `${((v as number) * 100).toFixed(2)}%`,
                      String(name),
                    ]}
                  />
                  <Legend wrapperStyle={{ color: 'var(--foreground)', fontSize: 12 }} />
                  {(service === 'all' || service === 'usdky') && (
                    <Line
                      type="monotone"
                      dataKey="usdky_yield"
                      stroke={HOLDERS_LINE_COLOR.usdky}
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                      name="USDKY"
                    />
                  )}
                  {(service === 'all' || service === 'gauntlet') && (
                    <Line
                      type="monotone"
                      dataKey="gauntlet_yield"
                      stroke={HOLDERS_LINE_COLOR.gauntlet}
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                      name="Gauntlet"
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {series && series.length === 0 && (
          <p className="mt-6 text-[#4C566A] dark:text-[#D8DEE9]">
            No snapshot data — run the backfill first.
          </p>
        )}

        <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
          <HoldersTable
            title="USDKY"
            accentBg="bg-[#5E81AC]"
            explorer="solana"
            data={usdkyHolders}
          />
          <HoldersTable
            title="Gauntlet Alpha"
            accentBg="bg-[#B48EAD]"
            explorer="base"
            data={gauntletHolders}
          />
        </div>

        <section className="mt-8 rounded-md border border-[#D8DEE9] bg-[#ECEFF4] p-6 shadow-sm dark:border-[#434C5E] dark:bg-[#3B4252]">
          <h2 className="text-xl font-bold sm:text-2xl">Not on KAST yet?</h2>
          <div className="mt-4 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <div className="rounded bg-white p-2 shadow-sm">
              <QRCodeSVG value={KAST_CTA_URL} size={120} level="M" />
            </div>
            <div className="space-y-2 text-sm">
              <p className="text-[#4C566A] dark:text-[#D8DEE9]">
                Sign up here. Get started in 2 minutes:
              </p>
              <a
                href={KAST_CTA_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="block break-all font-mono text-[#5E81AC] hover:underline dark:text-[#88C0D0]"
              >
                {KAST_CTA_URL}
              </a>
              <p className="text-xs text-[#4C566A] dark:text-[#D8DEE9]">
                Store, earn, move, and spend stablecoins globally.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function truncateAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function explorerUrl(explorer: 'solana' | 'base', addr: string): string {
  return explorer === 'solana'
    ? `https://solscan.io/account/${addr}`
    : `https://basescan.org/address/${addr}`;
}

function HoldersTable<T extends { wallet: string; usd_value: number }>({
  title,
  accentBg,
  explorer,
  data,
}: {
  title: string;
  accentBg: string;
  explorer: 'solana' | 'base';
  data: HoldersResponse<T> | null;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-[#D8DEE9] bg-[#ECEFF4] shadow-sm dark:border-[#434C5E] dark:bg-[#3B4252]">
      <div
        className={`${accentBg} flex items-center justify-between px-3 py-1.5 text-sm font-semibold text-white`}
      >
        <span>{title} — holders</span>
        <span className="text-xs font-normal opacity-90">
          {data
            ? `Top ${Math.min(data.holders.length, HOLDERS_LIMIT)} of ${data.total.toLocaleString()}${
                data.snapshot_date ? ` · ${data.snapshot_date}` : ''
              }`
            : 'loading…'}
        </span>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#E5E9F0] text-[#2E3440] dark:bg-[#434C5E] dark:text-[#ECEFF4]">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">#</th>
              <th className="px-2 py-1.5 text-left font-medium">Wallet</th>
              <th className="px-2 py-1.5 text-right font-medium">USD</th>
            </tr>
          </thead>
          <tbody>
            {data && data.holders.length === 0 && (
              <tr>
                <td
                  colSpan={3}
                  className="px-2 py-3 text-center text-[#4C566A] dark:text-[#D8DEE9]"
                >
                  No holders in range
                </td>
              </tr>
            )}
            {data?.holders.map((h, i) => (
              <tr
                key={h.wallet}
                className="border-t border-[#D8DEE9]/60 hover:bg-[#E5E9F0] dark:border-[#434C5E] dark:hover:bg-[#434C5E]"
              >
                <td className="px-2 py-1 text-[#4C566A] dark:text-[#D8DEE9]">{i + 1}</td>
                <td className="px-2 py-1 font-mono">
                  <a
                    href={explorerUrl(explorer, h.wallet)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#5E81AC] hover:underline dark:text-[#88C0D0]"
                  >
                    {truncateAddress(h.wallet)}
                  </a>
                </td>
                <td className="px-2 py-1 text-right font-mono">
                  ${Math.round(h.usd_value).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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
  rows: Array<[ReactNode, string]>;
  note: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-[#D8DEE9] bg-[#ECEFF4] shadow-sm dark:border-[#434C5E] dark:bg-[#3B4252]">
      <div className={`${accentBg} px-3 py-1.5 text-sm font-semibold text-white`}>{title}</div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 sm:grid-cols-3">
        {rows.map(([label, value], idx) => (
          <div key={idx}>
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

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const SIZE_BUCKETS = [
  'whale_100k+',
  'large_10k_100k',
  'mid_1k_10k',
  'retail_100_1k',
  'dust_lt_100',
] as const;

const KAST_USDKY_EXCLUDE_LABELS = ['treasury', 'infra', 'has_sol'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_START = '2026-01-07';
const DEFAULT_END = '9999-12-31';

type SizeRow = {
  date: string;
  'whale_100k+': string;
  large_10k_100k: string;
  mid_1k_10k: string;
  retail_100_1k: string;
  dust_lt_100: string;
  holders: number;
};

type ServiceRow = {
  date: string;
  usdky: string;
  gauntlet: string;
  usdky_holders: number;
  gauntlet_holders: number;
};

function parseExclude(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isKastOnly(raw: string | null): boolean {
  if (!raw) return false;
  const v = raw.toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function parseDate(raw: string | null, fallback: string): string {
  if (raw && DATE_RE.test(raw)) return raw;
  return fallback;
}

function shapeSizeRows(rows: SizeRow[]) {
  return rows.map((r) => {
    const obj: Record<string, string | number> = { date: r.date, holders: r.holders };
    for (const b of SIZE_BUCKETS) obj[b] = Number(r[b]);
    return obj;
  });
}

export async function GET(req: NextRequest) {
  const bucket = req.nextUrl.searchParams.get('bucket') ?? 'size';
  if (bucket !== 'size') {
    return NextResponse.json(
      { error: `bucket '${bucket}' not implemented; only 'size' is supported` },
      { status: 501 },
    );
  }
  const service = req.nextUrl.searchParams.get('service');
  const kastOnly = isKastOnly(req.nextUrl.searchParams.get('kast_only'));
  const exclude = kastOnly
    ? KAST_USDKY_EXCLUDE_LABELS
    : parseExclude(req.nextUrl.searchParams.get('exclude'));
  const start = parseDate(req.nextUrl.searchParams.get('start_date'), DEFAULT_START);
  const end = parseDate(req.nextUrl.searchParams.get('end_date'), DEFAULT_END);
  const db = getDb();

  if (service === 'usdky') {
    const rows = (await db`
      SELECT
        snapshot_date::text AS date,
        COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 100000), 0)::text AS "whale_100k+",
        COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 10000  AND usd_value < 100000), 0)::text AS "large_10k_100k",
        COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 1000   AND usd_value < 10000 ), 0)::text AS "mid_1k_10k",
        COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 100    AND usd_value < 1000  ), 0)::text AS "retail_100_1k",
        COALESCE(SUM(usd_value) FILTER (WHERE usd_value < 100                            ), 0)::text AS "dust_lt_100",
        COUNT(*)::int AS holders
      FROM usdky_snapshots s
      WHERE snapshot_date BETWEEN ${start}::date AND ${end}::date
        AND NOT EXISTS (
          SELECT 1 FROM kast_known_addresses k
          WHERE k.address = s.owner AND k.label = ANY(${exclude}::text[])
        )
      GROUP BY snapshot_date
      ORDER BY snapshot_date
    `) as SizeRow[];
    return NextResponse.json(shapeSizeRows(rows));
  }

  if (service === 'gauntlet') {
    const rows = kastOnly
      ? ((await db`
          SELECT
            snapshot_date::text AS date,
            COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 100000), 0)::text AS "whale_100k+",
            COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 10000  AND usd_value < 100000), 0)::text AS "large_10k_100k",
            COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 1000   AND usd_value < 10000 ), 0)::text AS "mid_1k_10k",
            COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 100    AND usd_value < 1000  ), 0)::text AS "retail_100_1k",
            COALESCE(SUM(usd_value) FILTER (WHERE usd_value < 100                            ), 0)::text AS "dust_lt_100",
            COUNT(*)::int AS holders
          FROM gauntlet_snapshots gs
          INNER JOIN kast_base_wallets kbw ON kbw.wallet = gs.holder
          WHERE gs.snapshot_date BETWEEN ${start}::date AND ${end}::date
          GROUP BY snapshot_date
          ORDER BY snapshot_date
        `) as SizeRow[])
      : ((await db`
          SELECT
            snapshot_date::text AS date,
            COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 100000), 0)::text AS "whale_100k+",
            COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 10000  AND usd_value < 100000), 0)::text AS "large_10k_100k",
            COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 1000   AND usd_value < 10000 ), 0)::text AS "mid_1k_10k",
            COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 100    AND usd_value < 1000  ), 0)::text AS "retail_100_1k",
            COALESCE(SUM(usd_value) FILTER (WHERE usd_value < 100                            ), 0)::text AS "dust_lt_100",
            COUNT(*)::int AS holders
          FROM gauntlet_snapshots
          WHERE snapshot_date BETWEEN ${start}::date AND ${end}::date
          GROUP BY snapshot_date
          ORDER BY snapshot_date
        `) as SizeRow[]);
    return NextResponse.json(shapeSizeRows(rows));
  }

  const rows = kastOnly
    ? ((await db`
        SELECT
          snapshot_date::text AS date,
          COALESCE(SUM(usdky_usd), 0)::text     AS usdky,
          COALESCE(SUM(gauntlet_usd), 0)::text  AS gauntlet,
          COALESCE(SUM(usdky_h), 0)::int        AS usdky_holders,
          COALESCE(SUM(gauntlet_h), 0)::int     AS gauntlet_holders
        FROM (
          SELECT s.snapshot_date,
                 s.usd_value AS usdky_usd, 0::numeric AS gauntlet_usd,
                 1 AS usdky_h, 0 AS gauntlet_h
          FROM usdky_snapshots s
          WHERE s.snapshot_date BETWEEN ${start}::date AND ${end}::date
            AND NOT EXISTS (
              SELECT 1 FROM kast_known_addresses k
              WHERE k.address = s.owner AND k.label = ANY(${exclude}::text[])
            )
          UNION ALL
          SELECT gs.snapshot_date, 0::numeric, gs.usd_value, 0, 1
          FROM gauntlet_snapshots gs
          INNER JOIN kast_base_wallets kbw ON kbw.wallet = gs.holder
          WHERE gs.snapshot_date BETWEEN ${start}::date AND ${end}::date
        ) t
        GROUP BY snapshot_date
        ORDER BY snapshot_date
      `) as ServiceRow[])
    : ((await db`
        SELECT
          snapshot_date::text AS date,
          COALESCE(SUM(usdky_usd), 0)::text     AS usdky,
          COALESCE(SUM(gauntlet_usd), 0)::text  AS gauntlet,
          COALESCE(SUM(usdky_h), 0)::int        AS usdky_holders,
          COALESCE(SUM(gauntlet_h), 0)::int     AS gauntlet_holders
        FROM (
          SELECT s.snapshot_date,
                 s.usd_value AS usdky_usd, 0::numeric AS gauntlet_usd,
                 1 AS usdky_h, 0 AS gauntlet_h
          FROM usdky_snapshots s
          WHERE s.snapshot_date BETWEEN ${start}::date AND ${end}::date
            AND NOT EXISTS (
              SELECT 1 FROM kast_known_addresses k
              WHERE k.address = s.owner AND k.label = ANY(${exclude}::text[])
            )
          UNION ALL
          SELECT snapshot_date, 0::numeric, usd_value, 0, 1
          FROM gauntlet_snapshots
          WHERE snapshot_date BETWEEN ${start}::date AND ${end}::date
        ) t
        GROUP BY snapshot_date
        ORDER BY snapshot_date
      `) as ServiceRow[]);

  return NextResponse.json(
    rows.map((r) => ({
      date: r.date,
      usdky: Number(r.usdky),
      gauntlet: Number(r.gauntlet),
      usdky_holders: r.usdky_holders,
      gauntlet_holders: r.gauntlet_holders,
    })),
  );
}

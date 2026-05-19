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

type SizeRow = {
  date: string;
  'whale_100k+': string;
  large_10k_100k: string;
  mid_1k_10k: string;
  retail_100_1k: string;
  dust_lt_100: string;
};

function parseExclude(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function GET(req: NextRequest) {
  const bucket = req.nextUrl.searchParams.get('bucket') ?? 'size';
  if (bucket !== 'size') {
    return NextResponse.json(
      { error: `bucket '${bucket}' not implemented; only 'size' is supported` },
      { status: 501 },
    );
  }
  const exclude = parseExclude(req.nextUrl.searchParams.get('exclude'));

  const db = getDb();
  const rows = (await db`
    SELECT
      snapshot_date::text AS date,
      COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 100000), 0)::text AS "whale_100k+",
      COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 10000  AND usd_value < 100000), 0)::text AS "large_10k_100k",
      COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 1000   AND usd_value < 10000 ), 0)::text AS "mid_1k_10k",
      COALESCE(SUM(usd_value) FILTER (WHERE usd_value >= 100    AND usd_value < 1000  ), 0)::text AS "retail_100_1k",
      COALESCE(SUM(usd_value) FILTER (WHERE usd_value < 100                            ), 0)::text AS "dust_lt_100"
    FROM usdky_snapshots s
    WHERE NOT EXISTS (
      SELECT 1 FROM kast_known_addresses k
      WHERE k.address = s.owner AND k.label = ANY(${exclude}::text[])
    )
    GROUP BY snapshot_date
    ORDER BY snapshot_date
  `) as SizeRow[];

  const out = rows.map((r) => {
    const obj: Record<string, string | number> = { date: r.date };
    for (const b of SIZE_BUCKETS) obj[b] = Number(r[b]);
    return obj;
  });
  return NextResponse.json(out);
}

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

function parseExclude(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function GET(req: NextRequest) {
  const exclude = parseExclude(req.nextUrl.searchParams.get('exclude'));
  const db = getDb();
  const rows = (await db`
    SELECT
      snapshot_date::text AS snapshot_date,
      COUNT(*)::int AS holders,
      COALESCE(SUM(usd_value), 0)::text AS total_usd,
      MAX(multiplier)::text AS multiplier
    FROM usdky_snapshots s
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM usdky_snapshots)
      AND NOT EXISTS (
        SELECT 1 FROM kast_known_addresses k
        WHERE k.address = s.owner AND k.label = ANY(${exclude}::text[])
      )
    GROUP BY snapshot_date
  `) as Array<{ snapshot_date: string; holders: number; total_usd: string; multiplier: string }>;

  if (rows.length === 0) {
    return NextResponse.json({ snapshot_date: null, holders: 0, total_usd: 0, multiplier: 0 });
  }
  const r = rows[0];
  return NextResponse.json({
    snapshot_date: r.snapshot_date,
    holders: r.holders,
    total_usd: Number(r.total_usd),
    multiplier: Number(r.multiplier),
  });
}

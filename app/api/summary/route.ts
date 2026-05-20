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

type UsdkyRow = {
  snapshot_date: string;
  holders: number;
  total_usd: string;
  multiplier: string;
};

type GauntletRow = {
  snapshot_date: string;
  holders: number;
  total_usd: string;
  share_price: string;
};

export async function GET(req: NextRequest) {
  const exclude = parseExclude(req.nextUrl.searchParams.get('exclude'));
  const db = getDb();

  const [usdkyRows, gauntletRows] = (await Promise.all([
    db`
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
    `,
    db`
      SELECT
        snapshot_date::text AS snapshot_date,
        COUNT(*)::int AS holders,
        COALESCE(SUM(usd_value), 0)::text AS total_usd,
        MAX(share_price)::text AS share_price
      FROM gauntlet_snapshots
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM gauntlet_snapshots)
      GROUP BY snapshot_date
    `,
  ])) as [UsdkyRow[], GauntletRow[]];

  const usdky =
    usdkyRows.length === 0
      ? { snapshot_date: null, holders: 0, total_usd: 0, multiplier: 0 }
      : {
          snapshot_date: usdkyRows[0].snapshot_date,
          holders: usdkyRows[0].holders,
          total_usd: Number(usdkyRows[0].total_usd),
          multiplier: Number(usdkyRows[0].multiplier),
        };

  const gauntlet =
    gauntletRows.length === 0
      ? { snapshot_date: null, holders: 0, total_usd: 0, share_price: 0 }
      : {
          snapshot_date: gauntletRows[0].snapshot_date,
          holders: gauntletRows[0].holders,
          total_usd: Number(gauntletRows[0].total_usd),
          share_price: Number(gauntletRows[0].share_price),
        };

  return NextResponse.json({ usdky, gauntlet });
}

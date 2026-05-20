import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const KAST_USDKY_EXCLUDE_LABELS = ['treasury', 'infra', 'has_sol'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_START = '2026-01-07';
const DEFAULT_END = '9999-12-31';

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
  const kastOnly = isKastOnly(req.nextUrl.searchParams.get('kast_only'));
  const exclude = kastOnly
    ? KAST_USDKY_EXCLUDE_LABELS
    : parseExclude(req.nextUrl.searchParams.get('exclude'));
  const start = parseDate(req.nextUrl.searchParams.get('start_date'), DEFAULT_START);
  const end = parseDate(req.nextUrl.searchParams.get('end_date'), DEFAULT_END);
  const db = getDb();

  const gauntletPromise = kastOnly
    ? db`
        SELECT
          gs.snapshot_date::text AS snapshot_date,
          COUNT(*)::int AS holders,
          COALESCE(SUM(gs.usd_value), 0)::text AS total_usd,
          MAX(gs.share_price)::text AS share_price
        FROM gauntlet_snapshots gs
        INNER JOIN kast_base_wallets kbw ON kbw.wallet = gs.holder
        WHERE gs.snapshot_date = (
          SELECT MAX(snapshot_date)
          FROM gauntlet_snapshots
          WHERE snapshot_date BETWEEN ${start}::date AND ${end}::date
        )
        GROUP BY gs.snapshot_date
      `
    : db`
        SELECT
          snapshot_date::text AS snapshot_date,
          COUNT(*)::int AS holders,
          COALESCE(SUM(usd_value), 0)::text AS total_usd,
          MAX(share_price)::text AS share_price
        FROM gauntlet_snapshots
        WHERE snapshot_date = (
          SELECT MAX(snapshot_date)
          FROM gauntlet_snapshots
          WHERE snapshot_date BETWEEN ${start}::date AND ${end}::date
        )
        GROUP BY snapshot_date
      `;

  const [usdkyRows, gauntletRows] = (await Promise.all([
    db`
      SELECT
        snapshot_date::text AS snapshot_date,
        COUNT(*)::int AS holders,
        COALESCE(SUM(usd_value), 0)::text AS total_usd,
        MAX(multiplier)::text AS multiplier
      FROM usdky_snapshots s
      WHERE snapshot_date = (
        SELECT MAX(snapshot_date)
        FROM usdky_snapshots
        WHERE snapshot_date BETWEEN ${start}::date AND ${end}::date
      )
        AND NOT EXISTS (
          SELECT 1 FROM kast_known_addresses k
          WHERE k.address = s.owner AND k.label = ANY(${exclude}::text[])
        )
      GROUP BY snapshot_date
    `,
    gauntletPromise,
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

  return NextResponse.json({ usdky, gauntlet, kast_only: kastOnly });
}

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_START = '2026-01-07';
const DEFAULT_END = '9999-12-31';

type GauntletRow = {
  effective_date: string;
  share_price: string;
  enter_events_today: number;
  daily_volume_usdc: string;
};

type UsdkyRow = {
  effective_date: string;
  share_price: string;
};

function parseDate(raw: string | null, fallback: string): string {
  if (raw && DATE_RE.test(raw)) return raw;
  return fallback;
}

export async function GET(req: NextRequest) {
  const service = req.nextUrl.searchParams.get('service') ?? 'gauntlet';
  const start = parseDate(req.nextUrl.searchParams.get('start_date'), DEFAULT_START);
  const end = parseDate(req.nextUrl.searchParams.get('end_date'), DEFAULT_END);
  const db = getDb();

  if (service === 'gauntlet') {
    const rows = (await db`
      SELECT
        effective_date::text AS effective_date,
        share_price::text    AS share_price,
        enter_events_today,
        daily_volume_usdc::text AS daily_volume_usdc
      FROM gauntlet_share_prices
      WHERE effective_date BETWEEN ${start}::date AND ${end}::date
      ORDER BY effective_date
    `) as GauntletRow[];

    return NextResponse.json(
      rows.map((r) => ({
        date: r.effective_date,
        share_price: Number(r.share_price),
        enter_events_today: r.enter_events_today,
        daily_volume_usdc: Number(r.daily_volume_usdc),
      })),
    );
  }

  if (service === 'usdky') {
    const rows = (await db`
      SELECT
        effective_date::text AS effective_date,
        multiplier::text     AS share_price
      FROM usdky_multipliers
      WHERE effective_date BETWEEN ${start}::date AND ${end}::date
      ORDER BY effective_date
    `) as UsdkyRow[];

    return NextResponse.json(
      rows.map((r) => ({
        date: r.effective_date,
        share_price: Number(r.share_price),
      })),
    );
  }

  return NextResponse.json({ error: `service '${service}' not supported` }, { status: 400 });
}

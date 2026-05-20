import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

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

export async function GET(req: NextRequest) {
  const service = req.nextUrl.searchParams.get('service') ?? 'gauntlet';
  const db = getDb();

  if (service === 'gauntlet') {
    const rows = (await db`
      SELECT
        effective_date::text AS effective_date,
        share_price::text    AS share_price,
        enter_events_today,
        daily_volume_usdc::text AS daily_volume_usdc
      FROM gauntlet_share_prices
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

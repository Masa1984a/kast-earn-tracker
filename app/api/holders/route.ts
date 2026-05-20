import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const KAST_USDKY_EXCLUDE_LABELS = ['treasury', 'infra', 'has_sol'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_START = '2026-01-07';
const DEFAULT_END = '9999-12-31';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

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

function parseLimit(raw: string | null): number {
  const n = raw ? Number(raw) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export async function GET(req: NextRequest) {
  const service = req.nextUrl.searchParams.get('service');
  if (service !== 'usdky' && service !== 'gauntlet') {
    return NextResponse.json(
      { error: `service must be 'usdky' or 'gauntlet'` },
      { status: 400 },
    );
  }

  const kastOnly = isKastOnly(req.nextUrl.searchParams.get('kast_only'));
  const exclude = kastOnly
    ? KAST_USDKY_EXCLUDE_LABELS
    : parseExclude(req.nextUrl.searchParams.get('exclude'));
  const start = parseDate(req.nextUrl.searchParams.get('start_date'), DEFAULT_START);
  const end = parseDate(req.nextUrl.searchParams.get('end_date'), DEFAULT_END);
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'));
  const db = getDb();

  if (service === 'usdky') {
    const [latestRow] = (await db`
      SELECT MAX(snapshot_date)::text AS snapshot_date
      FROM usdky_snapshots
      WHERE snapshot_date BETWEEN ${start}::date AND ${end}::date
    `) as Array<{ snapshot_date: string | null }>;
    const snapshotDate = latestRow?.snapshot_date ?? null;
    if (!snapshotDate) {
      return NextResponse.json({ service, snapshot_date: null, total: 0, holders: [] });
    }

    const [totals, rows] = (await Promise.all([
      db`
        SELECT COUNT(*)::int AS total
        FROM usdky_snapshots s
        WHERE snapshot_date = ${snapshotDate}::date
          AND NOT EXISTS (
            SELECT 1 FROM kast_known_addresses k
            WHERE k.address = s.owner AND k.label = ANY(${exclude}::text[])
          )
      `,
      db`
        SELECT
          owner       AS wallet,
          usd_value::text   AS usd_value,
          principal::text   AS principal,
          multiplier::text  AS multiplier
        FROM usdky_snapshots s
        WHERE snapshot_date = ${snapshotDate}::date
          AND NOT EXISTS (
            SELECT 1 FROM kast_known_addresses k
            WHERE k.address = s.owner AND k.label = ANY(${exclude}::text[])
          )
        ORDER BY s.usd_value DESC
        LIMIT ${limit}
      `,
    ])) as [
      Array<{ total: number }>,
      Array<{ wallet: string; usd_value: string; principal: string; multiplier: string }>,
    ];

    return NextResponse.json({
      service,
      snapshot_date: snapshotDate,
      total: totals[0]?.total ?? 0,
      holders: rows.map((r) => ({
        wallet: r.wallet,
        usd_value: Number(r.usd_value),
        principal: Number(r.principal),
        multiplier: Number(r.multiplier),
      })),
    });
  }

  // service === 'gauntlet'
  const [latestRow] = (await db`
    SELECT MAX(snapshot_date)::text AS snapshot_date
    FROM gauntlet_snapshots
    WHERE snapshot_date BETWEEN ${start}::date AND ${end}::date
  `) as Array<{ snapshot_date: string | null }>;
  const snapshotDate = latestRow?.snapshot_date ?? null;
  if (!snapshotDate) {
    return NextResponse.json({ service, snapshot_date: null, total: 0, holders: [] });
  }

  const [totals, rows] = kastOnly
    ? ((await Promise.all([
        db`
          SELECT COUNT(*)::int AS total
          FROM gauntlet_snapshots gs
          INNER JOIN kast_base_wallets kbw ON kbw.wallet = gs.holder
          WHERE gs.snapshot_date = ${snapshotDate}::date
        `,
        db`
          SELECT
            gs.holder        AS wallet,
            gs.usd_value::text   AS usd_value,
            gs.shares::text      AS shares,
            gs.share_price::text AS share_price
          FROM gauntlet_snapshots gs
          INNER JOIN kast_base_wallets kbw ON kbw.wallet = gs.holder
          WHERE gs.snapshot_date = ${snapshotDate}::date
          ORDER BY gs.usd_value DESC NULLS LAST
          LIMIT ${limit}
        `,
      ])) as [
        Array<{ total: number }>,
        Array<{ wallet: string; usd_value: string; shares: string; share_price: string }>,
      ])
    : ((await Promise.all([
        db`
          SELECT COUNT(*)::int AS total
          FROM gauntlet_snapshots
          WHERE snapshot_date = ${snapshotDate}::date
        `,
        db`
          SELECT
            holder        AS wallet,
            usd_value::text   AS usd_value,
            shares::text      AS shares,
            share_price::text AS share_price
          FROM gauntlet_snapshots
          WHERE snapshot_date = ${snapshotDate}::date
          ORDER BY gauntlet_snapshots.usd_value DESC NULLS LAST
          LIMIT ${limit}
        `,
      ])) as [
        Array<{ total: number }>,
        Array<{ wallet: string; usd_value: string; shares: string; share_price: string }>,
      ]);

  return NextResponse.json({
    service,
    snapshot_date: snapshotDate,
    total: totals[0]?.total ?? 0,
    holders: rows.map((r) => ({
      wallet: r.wallet,
      usd_value: Number(r.usd_value),
      shares: Number(r.shares),
      share_price: Number(r.share_price),
    })),
  });
}

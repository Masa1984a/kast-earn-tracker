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

function parseWallet(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
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
  const wallet = parseWallet(req.nextUrl.searchParams.get('wallet'));
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

    const [prevRow] = (await db`
      SELECT MAX(snapshot_date)::text AS prev_date
      FROM usdky_snapshots
      WHERE snapshot_date < ${snapshotDate}::date
    `) as Array<{ prev_date: string | null }>;
    const prevDate = prevRow?.prev_date ?? '1900-01-01';

    const [totals, rows] = (await Promise.all([
      db`
        SELECT COUNT(*)::int AS total
        FROM usdky_snapshots s
        WHERE snapshot_date = ${snapshotDate}::date
          AND (${wallet}::text IS NULL OR s.owner = ${wallet}::text)
          AND NOT EXISTS (
            SELECT 1 FROM kast_known_addresses k
            WHERE k.address = s.owner AND k.label = ANY(${exclude}::text[])
          )
      `,
      db`
        SELECT
          s.owner            AS wallet,
          s.usd_value::text  AS usd_value,
          s.principal::text  AS principal,
          s.multiplier::text AS multiplier,
          p.usd_value::text  AS prev_usd_value
        FROM usdky_snapshots s
        LEFT JOIN usdky_snapshots p
          ON p.owner = s.owner
         AND p.snapshot_date = ${prevDate}::date
        WHERE s.snapshot_date = ${snapshotDate}::date
          AND (${wallet}::text IS NULL OR s.owner = ${wallet}::text)
          AND NOT EXISTS (
            SELECT 1 FROM kast_known_addresses k
            WHERE k.address = s.owner AND k.label = ANY(${exclude}::text[])
          )
        ORDER BY s.usd_value DESC
        LIMIT ${limit}
      `,
    ])) as [
      Array<{ total: number }>,
      Array<{
        wallet: string;
        usd_value: string;
        principal: string;
        multiplier: string;
        prev_usd_value: string | null;
      }>,
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
        prev_usd_value: r.prev_usd_value == null ? null : Number(r.prev_usd_value),
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

  const [prevRow] = (await db`
    SELECT MAX(snapshot_date)::text AS prev_date
    FROM gauntlet_snapshots
    WHERE snapshot_date < ${snapshotDate}::date
  `) as Array<{ prev_date: string | null }>;
  const prevDate = prevRow?.prev_date ?? '1900-01-01';

  const [totals, rows] = kastOnly
    ? ((await Promise.all([
        db`
          SELECT COUNT(*)::int AS total
          FROM gauntlet_snapshots gs
          INNER JOIN kast_base_wallets kbw ON kbw.wallet = gs.holder
          WHERE gs.snapshot_date = ${snapshotDate}::date
            AND (${wallet}::text IS NULL OR gs.holder = ${wallet}::text)
        `,
        db`
          SELECT
            gs.holder            AS wallet,
            gs.usd_value::text   AS usd_value,
            gs.shares::text      AS shares,
            gs.share_price::text AS share_price,
            p.usd_value::text    AS prev_usd_value
          FROM gauntlet_snapshots gs
          INNER JOIN kast_base_wallets kbw ON kbw.wallet = gs.holder
          LEFT JOIN gauntlet_snapshots p
            ON p.holder = gs.holder
           AND p.snapshot_date = ${prevDate}::date
          WHERE gs.snapshot_date = ${snapshotDate}::date
            AND (${wallet}::text IS NULL OR gs.holder = ${wallet}::text)
          ORDER BY gs.usd_value DESC NULLS LAST
          LIMIT ${limit}
        `,
      ])) as [
        Array<{ total: number }>,
        Array<{
          wallet: string;
          usd_value: string;
          shares: string;
          share_price: string;
          prev_usd_value: string | null;
        }>,
      ])
    : ((await Promise.all([
        db`
          SELECT COUNT(*)::int AS total
          FROM gauntlet_snapshots
          WHERE snapshot_date = ${snapshotDate}::date
            AND (${wallet}::text IS NULL OR holder = ${wallet}::text)
        `,
        db`
          SELECT
            g.holder            AS wallet,
            g.usd_value::text   AS usd_value,
            g.shares::text      AS shares,
            g.share_price::text AS share_price,
            p.usd_value::text   AS prev_usd_value
          FROM gauntlet_snapshots g
          LEFT JOIN gauntlet_snapshots p
            ON p.holder = g.holder
           AND p.snapshot_date = ${prevDate}::date
          WHERE g.snapshot_date = ${snapshotDate}::date
            AND (${wallet}::text IS NULL OR g.holder = ${wallet}::text)
          ORDER BY g.usd_value DESC NULLS LAST
          LIMIT ${limit}
        `,
      ])) as [
        Array<{ total: number }>,
        Array<{
          wallet: string;
          usd_value: string;
          shares: string;
          share_price: string;
          prev_usd_value: string | null;
        }>,
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
      prev_usd_value: r.prev_usd_value == null ? null : Number(r.prev_usd_value),
    })),
  });
}

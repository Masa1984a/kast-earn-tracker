import { NextRequest, NextResponse } from 'next/server';
import { getDb, type NeonClient } from '@/lib/db';
import {
  executeQuery,
  GAUNTLET_PRICE_QUERY_ID,
  GAUNTLET_SNAPSHOTS_QUERY_ID,
  GAUNTLET_VAULT,
  KAST_BASE_WALLETS_QUERY_ID,
  KAST_ONRAMP,
  USDC_BASE,
} from '@/lib/dune';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

/** 欠損が無いときの通常 lookback。Dune 側の遅延データ差し替えも拾えるよう数日ぶん重ねる */
const DEFAULT_LOOKBACK_DAYS = 7;
/** 欠損検知でどれだけ遡って自己修復するかの上限。これを超える欠損は scripts/backfill-gauntlet-range.ts で手動復旧 */
const MAX_LOOKBACK_DAYS = 30;

type GapInfo = {
  earliest_missing: string | null;
  missing_days: number;
  capped: boolean;
};

/**
 * `end_date` から最大 MAX_LOOKBACK_DAYS 遡り、対象テーブルに行が無い日を検出する。
 * end_date 当日は「これから取りに行く日」なので除外する。
 */
async function detectGap(
  sql: NeonClient,
  endDate: string,
  target: 'snapshots' | 'price',
): Promise<GapInfo> {
  const rows = (
    target === 'snapshots'
      ? await sql`
          SELECT MIN(d)::date::text AS earliest_missing, COUNT(*)::int AS missing_days
          FROM generate_series(
            ${endDate}::date - ${MAX_LOOKBACK_DAYS}::int,
            ${endDate}::date - 1,
            interval '1 day'
          ) AS d
          WHERE NOT EXISTS (
            SELECT 1 FROM gauntlet_snapshots gs WHERE gs.snapshot_date = d::date
          )
        `
      : await sql`
          SELECT MIN(d)::date::text AS earliest_missing, COUNT(*)::int AS missing_days
          FROM generate_series(
            ${endDate}::date - ${MAX_LOOKBACK_DAYS}::int,
            ${endDate}::date - 1,
            interval '1 day'
          ) AS d
          WHERE NOT EXISTS (
            SELECT 1 FROM gauntlet_share_prices gp WHERE gp.effective_date = d::date
          )
        `
  ) as Array<{ earliest_missing: string | null; missing_days: number }>;

  const earliest = rows[0]?.earliest_missing ?? null;
  const missingDays = rows[0]?.missing_days ?? 0;
  // 上限日まで欠損が続いている = さらに古い欠損が残っている可能性がある
  const capped =
    earliest !== null && earliest <= isoDaysAgo(endDate, MAX_LOOKBACK_DAYS);

  return { earliest_missing: earliest, missing_days: missingDays, capped };
}

function isoDaysAgo(endDate: string, days: number): string {
  return new Date(Date.parse(`${endDate}T00:00:00Z`) - days * 86400_000)
    .toISOString()
    .slice(0, 10);
}

/** 欠損があればそこまで start_date を伸ばす。無ければ通常 lookback */
function resolveStartDate(endDate: string, gap: GapInfo): string {
  const defaultStart = isoDaysAgo(endDate, DEFAULT_LOOKBACK_DAYS);
  if (gap.earliest_missing && gap.earliest_missing < defaultStart) {
    return gap.earliest_missing;
  }
  return defaultStart;
}

type KickoffOptions = {
  query_id: number;
  job_kind: string;
  params: Record<string, string>;
};

type KickoffResult =
  | { skipped: true; job_kind: string; existing: { id: number; status: string } }
  | { skipped?: false; job_kind: string; job_id: number; execution_id: string };

async function kickoffJob(sql: NeonClient, opts: KickoffOptions): Promise<KickoffResult> {
  const existing = (await sql`
    SELECT id, status FROM dune_jobs
    WHERE job_kind = ${opts.job_kind}
      AND created_at::date = current_date
      AND status IN ('executing', 'completed')
    ORDER BY id DESC
    LIMIT 1
  `) as Array<{ id: number; status: string }>;

  if (existing.length > 0) {
    return { skipped: true, job_kind: opts.job_kind, existing: existing[0] };
  }

  const execution_id = await executeQuery(opts.query_id, opts.params);
  const inserted = (await sql`
    INSERT INTO dune_jobs (query_id, params, execution_id, status, job_kind, started_at)
    VALUES (
      ${opts.query_id},
      ${JSON.stringify(opts.params)}::jsonb,
      ${execution_id},
      'executing',
      ${opts.job_kind},
      now()
    )
    RETURNING id
  `) as Array<{ id: number }>;

  return { job_kind: opts.job_kind, job_id: inserted[0].id, execution_id };
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'cron not configured' }, { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sql = getDb();
  const end_date = new Date().toISOString().slice(0, 10);

  // 欠損日ベースで lookback を動的に決める（短時間の停止だけでなく長期停止も自己修復させる）
  const [snapshotGap, priceGap] = await Promise.all([
    detectGap(sql, end_date, 'snapshots'),
    detectGap(sql, end_date, 'price'),
  ]);
  const snapshotStart = resolveStartDate(end_date, snapshotGap);
  const priceStart = resolveStartDate(end_date, priceGap);

  const jobs = await Promise.all([
    kickoffJob(sql, {
      query_id: GAUNTLET_SNAPSHOTS_QUERY_ID,
      job_kind: 'gauntlet_daily',
      params: { start_date: snapshotStart, end_date, token: GAUNTLET_VAULT },
    }),
    kickoffJob(sql, {
      query_id: GAUNTLET_PRICE_QUERY_ID,
      job_kind: 'gauntlet_price',
      params: { start_date: priceStart, end_date, vault: GAUNTLET_VAULT },
    }),
    kickoffJob(sql, {
      query_id: KAST_BASE_WALLETS_QUERY_ID,
      job_kind: 'kast_base_wallets_daily',
      params: { vault: GAUNTLET_VAULT, usdc: USDC_BASE, kast_onramp: KAST_ONRAMP },
    }),
  ]);

  return NextResponse.json({
    windows: {
      snapshots: { start_date: snapshotStart, end_date },
      price: { start_date: priceStart, end_date },
    },
    gaps: { snapshots: snapshotGap, price: priceGap },
    max_lookback_days: MAX_LOOKBACK_DAYS,
    jobs,
  });
}

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
  const start_date = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);

  const jobs = await Promise.all([
    kickoffJob(sql, {
      query_id: GAUNTLET_SNAPSHOTS_QUERY_ID,
      job_kind: 'gauntlet_daily',
      params: { start_date, end_date, token: GAUNTLET_VAULT },
    }),
    kickoffJob(sql, {
      query_id: GAUNTLET_PRICE_QUERY_ID,
      job_kind: 'gauntlet_price',
      params: { start_date, end_date, vault: GAUNTLET_VAULT },
    }),
    kickoffJob(sql, {
      query_id: KAST_BASE_WALLETS_QUERY_ID,
      job_kind: 'kast_base_wallets_daily',
      params: { vault: GAUNTLET_VAULT, usdc: USDC_BASE, kast_onramp: KAST_ONRAMP },
    }),
  ]);

  return NextResponse.json({ window: { start_date, end_date }, jobs });
}

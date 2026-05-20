import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
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

type Kind = 'snapshots' | 'price' | 'kast_wallets';
const DEFAULT_KINDS: Kind[] = ['snapshots', 'price', 'kast_wallets'];
const VALID_KINDS: ReadonlyArray<Kind> = ['snapshots', 'price', 'kast_wallets'];

function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isKind(k: unknown): k is Kind {
  return VALID_KINDS.includes(k as Kind);
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'cron not configured' }, { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    start_date?: unknown;
    end_date?: unknown;
    kinds?: unknown;
  };

  const wantsKastOnly =
    Array.isArray(body.kinds) &&
    body.kinds.every((k) => k === 'kast_wallets');

  if (!wantsKastOnly && (!isDate(body.start_date) || !isDate(body.end_date))) {
    return NextResponse.json(
      { error: 'start_date and end_date are required (YYYY-MM-DD) unless kinds=[kast_wallets] only' },
      { status: 400 },
    );
  }

  const requested = Array.isArray(body.kinds) ? (body.kinds as unknown[]) : DEFAULT_KINDS;
  const kinds: Kind[] = requested.filter(isKind);
  if (kinds.length === 0) {
    return NextResponse.json(
      { error: `kinds must include at least one of: ${VALID_KINDS.join(', ')}` },
      { status: 400 },
    );
  }

  const start_date = isDate(body.start_date) ? body.start_date : null;
  const end_date = isDate(body.end_date) ? body.end_date : null;
  const sql = getDb();
  const jobs: Array<{ kind: string; job_id: number; execution_id: string }> = [];

  if (kinds.includes('snapshots') && start_date && end_date) {
    const params = { start_date, end_date, token: GAUNTLET_VAULT };
    const execution_id = await executeQuery(GAUNTLET_SNAPSHOTS_QUERY_ID, params);
    const inserted = (await sql`
      INSERT INTO dune_jobs (query_id, params, execution_id, status, job_kind, started_at)
      VALUES (
        ${GAUNTLET_SNAPSHOTS_QUERY_ID},
        ${JSON.stringify(params)}::jsonb,
        ${execution_id},
        'executing',
        'gauntlet_backfill',
        now()
      )
      RETURNING id
    `) as Array<{ id: number }>;
    jobs.push({ kind: 'gauntlet_backfill', job_id: inserted[0].id, execution_id });
  }

  if (kinds.includes('price') && start_date && end_date) {
    const params = { start_date, end_date, vault: GAUNTLET_VAULT };
    const execution_id = await executeQuery(GAUNTLET_PRICE_QUERY_ID, params);
    const inserted = (await sql`
      INSERT INTO dune_jobs (query_id, params, execution_id, status, job_kind, started_at)
      VALUES (
        ${GAUNTLET_PRICE_QUERY_ID},
        ${JSON.stringify(params)}::jsonb,
        ${execution_id},
        'executing',
        'gauntlet_price_backfill',
        now()
      )
      RETURNING id
    `) as Array<{ id: number }>;
    jobs.push({ kind: 'gauntlet_price_backfill', job_id: inserted[0].id, execution_id });
  }

  if (kinds.includes('kast_wallets')) {
    const params = { vault: GAUNTLET_VAULT, usdc: USDC_BASE, kast_onramp: KAST_ONRAMP };
    const execution_id = await executeQuery(KAST_BASE_WALLETS_QUERY_ID, params);
    const inserted = (await sql`
      INSERT INTO dune_jobs (query_id, params, execution_id, status, job_kind, started_at)
      VALUES (
        ${KAST_BASE_WALLETS_QUERY_ID},
        ${JSON.stringify(params)}::jsonb,
        ${execution_id},
        'executing',
        'kast_base_wallets_backfill',
        now()
      )
      RETURNING id
    `) as Array<{ id: number }>;
    jobs.push({ kind: 'kast_base_wallets_backfill', job_id: inserted[0].id, execution_id });
  }

  return NextResponse.json({
    jobs,
    note: 'Jobs queued. dune-poll cron will pick them up within 10 minutes.',
  });
}

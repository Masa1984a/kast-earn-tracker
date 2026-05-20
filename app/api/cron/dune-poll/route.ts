import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getExecutionResults, getExecutionStatus } from '@/lib/dune';
import { ingestJobResults } from '@/lib/ingest';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const STALE_HOURS = 1;
const POLL_LIMIT = 5;

type JobRow = { id: number; execution_id: string; job_kind: string };

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'cron not configured' }, { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sql = getDb();

  await sql`
    UPDATE dune_jobs
    SET status = 'failed',
        completed_at = now(),
        error_message = 'Stale: exceeded ' || ${STALE_HOURS}::text || ' hour(s)'
    WHERE status = 'executing'
      AND started_at < now() - (interval '1 hour' * ${STALE_HOURS})
  `;

  const jobs = (await sql`
    SELECT id, execution_id, job_kind
    FROM dune_jobs
    WHERE status = 'executing'
    ORDER BY started_at ASC
    LIMIT ${POLL_LIMIT}
  `) as JobRow[];

  if (jobs.length === 0) {
    return NextResponse.json({ polled: 0, note: 'no executing jobs' });
  }

  const results: unknown[] = [];

  for (const job of jobs) {
    try {
      const { state } = await getExecutionStatus(job.execution_id);

      if (state === 'QUERY_STATE_COMPLETED') {
        const rows = await getExecutionResults(job.execution_id);
        const { inserted } = await ingestJobResults(sql, job.job_kind, rows);
        await sql`
          UPDATE dune_jobs
          SET status = 'completed', completed_at = now(), rows_count = ${inserted}
          WHERE id = ${job.id}
        `;
        results.push({
          job_id: job.id,
          job_kind: job.job_kind,
          status: 'completed',
          rows: inserted,
        });
      } else if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') {
        await sql`
          UPDATE dune_jobs
          SET status = 'failed', completed_at = now(), error_message = ${state}
          WHERE id = ${job.id}
        `;
        results.push({
          job_id: job.id,
          job_kind: job.job_kind,
          status: 'failed',
          state,
        });
      } else {
        results.push({
          job_id: job.id,
          job_kind: job.job_kind,
          status: 'still_executing',
          state,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        job_id: job.id,
        job_kind: job.job_kind,
        status: 'poll_error',
        error: msg,
      });
    }
  }

  return NextResponse.json({ polled: jobs.length, results });
}

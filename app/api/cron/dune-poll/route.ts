import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getExecutionResults, getExecutionStatus } from '@/lib/dune';
import { ingestJobResults } from '@/lib/ingest';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const STALE_HOURS = 2;
const POLL_LIMIT = 5;
/**
 * cron の maxDuration = 60 秒で取り込める行数の上限。
 * これを超える結果を掴むと ingest 途中で関数が殺され、行だけ部分コミットされて
 * job は executing のまま残る（Phase 17 調査結果 4 の 08-22 / 08-26 部分欠損）。
 * 壊れたデータを書くより明示的に failed にして手動 backfill に回す。
 */
const MAX_CRON_INGEST_ROWS = 80_000;

type JobRow = { id: number; execution_id: string; job_kind: string };

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'cron not configured' }, { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sql = getDb();

  // stale の打ち切りは「処理した後」に回す。SELECT より前に UPDATE すると、
  // Dune 側で完了済みの job を拾う前に failed にしてしまう（Phase 17 調査結果 5）
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
      const { state, raw } = await getExecutionStatus(job.execution_id);

      if (state === 'QUERY_STATE_COMPLETED') {
        const totalRows = (raw as { result_metadata?: { total_row_count?: number } })
          .result_metadata?.total_row_count;
        if (typeof totalRows === 'number' && totalRows > MAX_CRON_INGEST_ROWS) {
          const msg =
            `Too large for cron ingest: ${totalRows} rows > ${MAX_CRON_INGEST_ROWS}. ` +
            `Run scripts/backfill-gauntlet-range.ts --execution-id ${job.execution_id}`;
          await sql`
            UPDATE dune_jobs
            SET status = 'failed', completed_at = now(), error_message = ${msg}
            WHERE id = ${job.id}
          `;
          results.push({
            job_id: job.id,
            job_kind: job.job_kind,
            status: 'too_large',
            rows: totalRows,
            execution_id: job.execution_id,
          });
          continue;
        }

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

  // 処理し終えてから、Dune 側で終わる見込みの無い job を打ち切る
  const staled = (await sql`
    UPDATE dune_jobs
    SET status = 'failed',
        completed_at = now(),
        error_message = 'Stale: exceeded ' || ${STALE_HOURS}::text || ' hour(s)'
    WHERE status = 'executing'
      AND started_at < now() - (interval '1 hour' * ${STALE_HOURS})
    RETURNING id
  `) as Array<{ id: number }>;

  return NextResponse.json({ polled: jobs.length, results, staled: staled.map((r) => r.id) });
}

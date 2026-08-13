/**
 * 指定 dune_jobs が終端状態 (completed / failed) になるまで待つ。
 * 本番 dune-poll cron が取り込むのを待つ用途。
 *
 *   npx tsx --env-file=.env.local scripts/wait-dune-jobs.ts 216 217
 *   npx tsx --env-file=.env.local scripts/wait-dune-jobs.ts            # executing 全件
 *
 * exit 0 = 全 job completed / exit 1 = 1 件以上 failed / exit 2 = timeout
 */
import { argv, exit } from 'node:process';
import { getDb } from '../lib/db';
import { sleep } from '../lib/helius';

const POLL_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 50 * 60_000;

type JobRow = {
  id: number;
  job_kind: string;
  status: string;
  rows_count: number | null;
  error_message: string | null;
};

async function main() {
  const ids = argv.slice(2).map(Number).filter((n) => Number.isInteger(n));
  const sql = getDb({ unpooled: true });
  const startedAt = Date.now();
  const lastSeen = new Map<number, string>();

  for (;;) {
    const jobs = (
      ids.length > 0
        ? await sql`
            SELECT id, job_kind, status, rows_count, error_message
            FROM dune_jobs WHERE id = ANY(${ids}::int[]) ORDER BY id
          `
        : await sql`
            SELECT id, job_kind, status, rows_count, error_message
            FROM dune_jobs WHERE status = 'executing' ORDER BY id
          `
    ) as JobRow[];

    if (jobs.length === 0) {
      console.log('待機対象の job がありません');
      exit(0);
    }

    for (const j of jobs) {
      if (lastSeen.get(j.id) !== j.status) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        console.log(
          `[+${elapsed}s] #${j.id} ${j.job_kind}: ${j.status}` +
            (j.rows_count !== null ? ` rows=${j.rows_count}` : '') +
            (j.error_message ? ` err=${j.error_message}` : ''),
        );
        lastSeen.set(j.id, j.status);
      }
    }

    const pending = jobs.filter((j) => j.status === 'executing' || j.status === 'queued');
    if (pending.length === 0) {
      const failed = jobs.filter((j) => j.status === 'failed');
      if (failed.length > 0) {
        console.log(`FAILED: ${failed.map((j) => `#${j.id} (${j.error_message ?? '-'})`).join(', ')}`);
        exit(1);
      }
      console.log('ALL COMPLETED');
      exit(0);
    }

    if (Date.now() - startedAt > TIMEOUT_MS) {
      console.log(`TIMEOUT: まだ ${pending.map((j) => `#${j.id}`).join(', ')} が executing`);
      exit(2);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

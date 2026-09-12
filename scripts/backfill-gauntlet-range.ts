/**
 * 指定期間の Gauntlet データ (snapshots / price / kast_wallets) を Dune で再取得し、
 * results の取得と ingest までローカルで完走させる自己完結スクリプト。
 *
 * 本番 `dune-poll` cron は `maxDuration = 60` 秒しかなく、10 万行級の結果を取り込む途中で
 * 関数が殺される。すると行だけ部分コミットされて `dune_jobs` は `executing` のまま残り、
 * 次の poll で stale として捨てられる（Phase 17 調査結果 4）。手動 backfill はそこに頼らない。
 *
 *   npx tsx --env-file=.env.local scripts/backfill-gauntlet-range.ts --from 2026-08-22 --to 2026-09-11 --kinds snapshots
 *   ... --kinds snapshots,price,kast_wallets   （既定は snapshots,price）
 *   ... --no-wait            kickoff だけして ingest は本番 dune-poll に任せる（従来動作）
 *   ... --execution-id <id>  kickoff せず既存 execution の results だけ取り込む（クレジット消費なし / kind は 1 つだけ指定）
 *   ... --timeout-min 90     Dune の完了待ちタイムアウト（既定 60 分）
 *   ... --dry-run            Dune を叩かず対象期間の現状だけ表示
 */
import { argv, exit } from 'node:process';
import { getDb, type NeonClient } from '../lib/db';
import { ingestJobResults } from '../lib/ingest';
import {
  executeQuery,
  getAllExecutionResults,
  getExecutionStatus,
  GAUNTLET_PRICE_QUERY_ID,
  GAUNTLET_SNAPSHOTS_QUERY_ID,
  GAUNTLET_VAULT,
  KAST_BASE_WALLETS_QUERY_ID,
  KAST_ONRAMP,
  USDC_BASE,
} from '../lib/dune';

type Kind = 'snapshots' | 'price' | 'kast_wallets';
const VALID_KINDS: readonly Kind[] = ['snapshots', 'price', 'kast_wallets'];

const JOB_KIND: Record<Kind, string> = {
  snapshots: 'gauntlet_backfill',
  price: 'gauntlet_price_backfill',
  kast_wallets: 'kast_base_wallets_backfill',
};
const QUERY_ID: Record<Kind, number> = {
  snapshots: GAUNTLET_SNAPSHOTS_QUERY_ID,
  price: GAUNTLET_PRICE_QUERY_ID,
  kast_wallets: KAST_BASE_WALLETS_QUERY_ID,
};

/** ingest 1 回あたりの行数。進捗ログを出すためにローカルで刻む */
const INGEST_CHUNK = 10_000;
/** Dune の完了待ちポーリング間隔 */
const POLL_INTERVAL_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseArgs() {
  let from: string | undefined;
  let to: string | undefined;
  let kinds: Kind[] = ['snapshots', 'price'];
  let dryRun = false;
  let wait = true;
  let executionId: string | undefined;
  let timeoutMin = 60;

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--kinds') kinds = argv[++i].split(',').map((k) => k.trim()) as Kind[];
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--wait') wait = true;
    else if (a === '--no-wait') wait = false;
    else if (a === '--execution-id') executionId = argv[++i];
    else if (a === '--timeout-min') timeoutMin = Number(argv[++i]);
    else {
      console.error(`unknown argument: ${a}`);
      exit(1);
    }
  }

  for (const k of kinds) {
    if (!VALID_KINDS.includes(k)) {
      console.error(`invalid kind: ${k} (${VALID_KINDS.join(' | ')})`);
      exit(1);
    }
  }
  if (executionId && kinds.length !== 1) {
    console.error('--execution-id を使う場合は --kinds を 1 つだけ指定すること');
    exit(1);
  }
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
    console.error(`invalid --timeout-min: ${timeoutMin}`);
    exit(1);
  }

  const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  // kast_wallets は期間パラメータを取らないので、それ単独なら --from/--to は不要
  const needsDates = kinds.some((k) => k !== 'kast_wallets') && !executionId;
  if (needsDates && (!isDate(from) || !isDate(to))) {
    console.error(
      'Usage: --from YYYY-MM-DD --to YYYY-MM-DD [--kinds snapshots,price,kast_wallets] [--no-wait] [--dry-run]',
    );
    exit(1);
  }
  if (from && to && from > to) {
    console.error(`--from (${from}) が --to (${to}) より後になっている`);
    exit(1);
  }

  return { from, to, kinds, dryRun, wait, executionId, timeoutMin };
}

function paramsFor(kind: Kind, from?: string, to?: string): Record<string, string> {
  if (kind === 'snapshots') return { start_date: from!, end_date: to!, token: GAUNTLET_VAULT };
  if (kind === 'price') return { start_date: from!, end_date: to!, vault: GAUNTLET_VAULT };
  return { vault: GAUNTLET_VAULT, usdc: USDC_BASE, kast_onramp: KAST_ONRAMP };
}

async function showCurrentState(sql: NeonClient, from: string, to: string) {
  const before = (await sql`
    SELECT d::date::text AS d,
           (SELECT COUNT(*)::int FROM gauntlet_snapshots gs WHERE gs.snapshot_date = d::date) AS snap_rows,
           (SELECT COUNT(*)::int FROM gauntlet_snapshots gs
             WHERE gs.snapshot_date = d::date AND gs.share_price = 1) AS sp1_rows,
           (SELECT COUNT(*)::int FROM gauntlet_share_prices gp WHERE gp.effective_date = d::date) AS price_rows
    FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS d
    ORDER BY d
  `) as Array<{ d: string; snap_rows: number; sp1_rows: number; price_rows: number }>;
  console.log('現状:');
  for (const r of before) {
    const warn =
      r.snap_rows === 0 ? ' <== MISSING' : r.sp1_rows > 0 ? ` <== share_price=1 が ${r.sp1_rows} 行` : '';
    console.log(`  ${r.d}: snapshots=${r.snap_rows} price=${r.price_rows}${warn}`);
  }
}

/** Dune の実行完了を待つ。completed 以外で終わったら throw */
async function waitForCompletion(executionId: string, timeoutMin: number): Promise<void> {
  const deadline = Date.now() + timeoutMin * 60_000;
  const startedAt = Date.now();
  for (;;) {
    const { state } = await getExecutionStatus(executionId);
    const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
    if (state === 'QUERY_STATE_COMPLETED') {
      console.log(`    ${state} (${elapsedMin} 分)`);
      return;
    }
    if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') {
      throw new Error(`Dune execution ${executionId} ended with ${state}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Dune execution ${executionId} が ${timeoutMin} 分たっても終わらない (state=${state})。` +
          ` 後から --execution-id ${executionId} で results だけ取り込めます`,
      );
    }
    console.log(`    ${state} (${elapsedMin} 分経過) ...`);
    await sleep(POLL_INTERVAL_MS);
  }
}

/** results を取得してローカルで ingest する。dune-poll には触らせない */
async function fetchAndIngest(sql: NeonClient, kind: Kind, executionId: string): Promise<number> {
  console.log('    results 取得中...');
  const rows = await getAllExecutionResults(executionId, {
    onPage: (fetched, total) => console.log(`      fetched [${fetched} / ${total ?? '?'}]`),
  });
  console.log(`    ${rows.length} 行を ingest 開始`);

  let inserted = 0;
  for (let i = 0; i < rows.length; i += INGEST_CHUNK) {
    const chunk = rows.slice(i, i + INGEST_CHUNK);
    const res = await ingestJobResults(sql, JOB_KIND[kind], chunk);
    inserted += res.inserted;
    console.log(`      ingested [${Math.min(i + INGEST_CHUNK, rows.length)} / ${rows.length}]`);
  }
  return inserted;
}

async function main() {
  const { from, to, kinds, dryRun, wait, executionId, timeoutMin } = parseArgs();
  const sql = getDb({ unpooled: true });

  const windowLabel = from && to ? `${from} .. ${to}` : '(期間パラメータなし)';
  console.log(
    `window: ${windowLabel} / kinds: ${kinds.join(',')}` +
      `${dryRun ? ' (dry-run)' : ''}${wait ? '' : ' (no-wait)'}` +
      `${executionId ? ` (ingest only: ${executionId})` : ''}`,
  );

  if (from && to) await showCurrentState(sql, from, to);

  if (dryRun) {
    console.log('dry-run のため Dune は叩かない');
    return;
  }

  for (const kind of kinds) {
    const params = paramsFor(kind, from, to);
    console.log(`\n[${kind}]`);

    // --execution-id 指定時は kickoff せず、既存の実行結果を取り込むだけ（クレジット消費ゼロ）
    const execId = executionId ?? (await executeQuery(QUERY_ID[kind], params));
    if (!executionId) console.log(`    kicked off: execution_id=${execId}`);

    if (!wait) {
      const queued = (await sql`
        INSERT INTO dune_jobs (query_id, params, execution_id, status, job_kind, started_at)
        VALUES (${QUERY_ID[kind]}, ${JSON.stringify(params)}::jsonb, ${execId},
                'executing', ${JOB_KIND[kind]}, now())
        RETURNING id
      `) as Array<{ id: number }>;
      console.log(`    job_id=${queued[0].id} を executing で登録。本番 dune-poll cron (30 分毎) が取り込みます`);
      continue;
    }

    // status='local' で登録する。dune-poll は 'executing' しか拾わないので二重取得されない
    const jobRows = (await sql`
      INSERT INTO dune_jobs (query_id, params, execution_id, status, job_kind, started_at)
      VALUES (${QUERY_ID[kind]}, ${JSON.stringify(params)}::jsonb, ${execId},
              'local', ${JOB_KIND[kind]}, now())
      RETURNING id
    `) as Array<{ id: number }>;
    const jobId = jobRows[0].id;
    console.log(`    job_id=${jobId} (status=local)`);

    try {
      await waitForCompletion(execId, timeoutMin);
      const inserted = await fetchAndIngest(sql, kind, execId);
      await sql`
        UPDATE dune_jobs
        SET status = 'completed', completed_at = now(), rows_count = ${inserted}
        WHERE id = ${jobId}
      `;
      console.log(`    done: ${inserted} 行 ingest → job #${jobId} completed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sql`
        UPDATE dune_jobs
        SET status = 'failed', completed_at = now(), error_message = ${msg}
        WHERE id = ${jobId}
      `;
      console.error(`    failed: ${msg}`);
      throw err;
    }
  }

  console.log('\n確認: npx tsx --env-file=.env.local scripts/diag-gauntlet-gap.ts --from ... --to ...');
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

/**
 * 指定期間の Gauntlet データ (snapshots / price) を Dune に kickoff して
 * `dune_jobs` に executing 行を積むだけのスクリプト。
 * results の取得と ingest は本番の `dune-poll` cron (30 分毎) に任せる。
 * → /results 取得が 1 回だけになり Dune クレジットを無駄にしない。
 *
 *   npx tsx --env-file=.env.local scripts/backfill-gauntlet-range.ts --from 2026-07-30 --to 2026-08-04
 *   npx tsx --env-file=.env.local scripts/backfill-gauntlet-range.ts --from ... --to ... --kinds snapshots
 *   --dry-run で Dune を叩かずに対象確認のみ
 */
import { argv, exit } from 'node:process';
import { getDb } from '../lib/db';
import {
  executeQuery,
  GAUNTLET_PRICE_QUERY_ID,
  GAUNTLET_SNAPSHOTS_QUERY_ID,
  GAUNTLET_VAULT,
} from '../lib/dune';

type Kind = 'snapshots' | 'price';

const JOB_KIND: Record<Kind, string> = {
  snapshots: 'gauntlet_backfill',
  price: 'gauntlet_price_backfill',
};
const QUERY_ID: Record<Kind, number> = {
  snapshots: GAUNTLET_SNAPSHOTS_QUERY_ID,
  price: GAUNTLET_PRICE_QUERY_ID,
};

function parseArgs() {
  let from: string | undefined;
  let to: string | undefined;
  let kinds: Kind[] = ['snapshots', 'price'];
  let dryRun = false;

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--kinds') {
      kinds = argv[++i].split(',').map((k) => k.trim()) as Kind[];
    } else if (a === '--dry-run') dryRun = true;
    else {
      console.error(`unknown argument: ${a}`);
      exit(1);
    }
  }

  const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(from) || !isDate(to)) {
    console.error('Usage: --from YYYY-MM-DD --to YYYY-MM-DD [--kinds snapshots,price] [--dry-run]');
    exit(1);
  }
  for (const k of kinds) {
    if (k !== 'snapshots' && k !== 'price') {
      console.error(`invalid kind: ${k} (snapshots | price)`);
      exit(1);
    }
  }
  return { from, to, kinds, dryRun };
}

async function main() {
  const { from, to, kinds, dryRun } = parseArgs();
  const sql = getDb({ unpooled: true });

  console.log(`window: ${from} .. ${to} / kinds: ${kinds.join(',')}${dryRun ? ' (dry-run)' : ''}`);

  const before = (await sql`
    SELECT d::date::text AS d,
           (SELECT COUNT(*)::int FROM gauntlet_snapshots gs WHERE gs.snapshot_date = d::date) AS snap_rows,
           (SELECT COUNT(*)::int FROM gauntlet_share_prices gp WHERE gp.effective_date = d::date) AS price_rows
    FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS d
    ORDER BY d
  `) as Array<{ d: string; snap_rows: number; price_rows: number }>;
  console.log('現状:');
  for (const r of before) console.log(`  ${r.d}: snapshots=${r.snap_rows} price=${r.price_rows}`);

  if (dryRun) {
    console.log('dry-run のため Dune は叩かない');
    return;
  }

  for (const kind of kinds) {
    const params: Record<string, string> =
      kind === 'snapshots'
        ? { start_date: from, end_date: to, token: GAUNTLET_VAULT }
        : { start_date: from, end_date: to, vault: GAUNTLET_VAULT };

    const execution_id = await executeQuery(QUERY_ID[kind], params);
    const inserted = (await sql`
      INSERT INTO dune_jobs (query_id, params, execution_id, status, job_kind, started_at)
      VALUES (
        ${QUERY_ID[kind]},
        ${JSON.stringify(params)}::jsonb,
        ${execution_id},
        'executing',
        ${JOB_KIND[kind]},
        now()
      )
      RETURNING id
    `) as Array<{ id: number }>;
    console.log(`  kicked off ${kind}: job_id=${inserted[0].id} execution_id=${execution_id}`);
  }

  console.log('\n本番 dune-poll cron (30 分毎) が results を取り込むまで待機してください。');
  console.log('確認: npx tsx --env-file=.env.local scripts/diag-gauntlet-gap.ts');
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

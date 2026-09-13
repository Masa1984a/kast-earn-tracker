/**
 * Phase 19: `gauntlet_snapshots` の明細から `gauntlet_daily_rollup` を作り直す。
 * Dune も外部 API も叩かない（クレジット消費ゼロ）。
 *
 *   npx tsx --env-file=.env.local scripts/backfill-gauntlet-rollup.ts              全期間
 *   npx tsx --env-file=.env.local scripts/backfill-gauntlet-rollup.ts --from ... --to ...
 *   ... --missing-only   集計行がまだ無い日だけ
 *   ... --verify         集計と明細が一致しているかだけ確認して終了
 */
import { argv, exit } from 'node:process';
import { getDb } from '../lib/db';
import { refreshGauntletRollup } from '../lib/rollup';

/** 1 回の refresh で扱う日数。1 日あたり約 7,600 行を 2 スコープ集計する */
const CHUNK_DAYS = 20;

function parseArgs() {
  let from: string | undefined;
  let to: string | undefined;
  let missingOnly = false;
  let verify = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--missing-only') missingOnly = true;
    else if (a === '--verify') verify = true;
    else {
      console.error(`unknown argument: ${a}`);
      exit(1);
    }
  }
  const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  for (const [k, v] of [['--from', from], ['--to', to]] as const) {
    if (v !== undefined && !isDate(v)) {
      console.error(`invalid ${k}: ${v} (YYYY-MM-DD)`);
      exit(1);
    }
  }
  return { from, to, missingOnly, verify };
}

async function main() {
  const { from, to, missingOnly, verify } = parseArgs();
  const sql = getDb({ unpooled: true });

  if (verify) {
    // 明細が残っている日だけ突合できる（保持期間の外は明細が無いので対象外）
    const diff = (await sql`
      WITH detail AS (
        SELECT gs.snapshot_date AS d,
               COUNT(*)::int AS holders,
               ROUND(COALESCE(SUM(gs.usd_value), 0), 6) AS total_usd
        FROM gauntlet_snapshots gs
        GROUP BY gs.snapshot_date
      )
      SELECT d::text AS d, detail.holders AS detail_holders, r.holders AS rollup_holders,
             detail.total_usd::text AS detail_usd, ROUND(r.total_usd, 6)::text AS rollup_usd
      FROM detail
      LEFT JOIN gauntlet_daily_rollup r ON r.snapshot_date = detail.d AND r.scope = 'all'
      WHERE r.snapshot_date IS NULL
         OR r.holders <> detail.holders
         OR ROUND(r.total_usd, 6) <> detail.total_usd
      ORDER BY d
    `) as Array<Record<string, string>>;
    if (diff.length === 0) {
      console.log('OK: 明細が残っている全日で holders / total_usd が一致');
    } else {
      console.log(`不一致 ${diff.length} 日:`);
      for (const r of diff) {
        console.log(`  ${r.d}: detail=${r.detail_holders}/${r.detail_usd} rollup=${r.rollup_holders ?? '-'}/${r.rollup_usd ?? '-'}`);
      }
    }
    return;
  }

  const targets = (await sql`
    SELECT DISTINCT gs.snapshot_date::text AS d
    FROM gauntlet_snapshots gs
    WHERE (${from ?? null}::date IS NULL OR gs.snapshot_date >= ${from ?? null}::date)
      AND (${to ?? null}::date IS NULL OR gs.snapshot_date <= ${to ?? null}::date)
      AND (
        NOT ${missingOnly}::boolean
        OR NOT EXISTS (
          SELECT 1 FROM gauntlet_daily_rollup r
          WHERE r.snapshot_date = gs.snapshot_date AND r.scope = 'all'
        )
      )
    ORDER BY d
  `) as Array<{ d: string }>;

  const dates = targets.map((r) => r.d);
  console.log(`対象 ${dates.length} 日${dates.length ? ` (${dates[0]} .. ${dates[dates.length - 1]})` : ''}`);
  if (dates.length === 0) return;

  for (let i = 0; i < dates.length; i += CHUNK_DAYS) {
    const chunk = dates.slice(i, i + CHUNK_DAYS);
    await refreshGauntletRollup(sql, chunk);
    console.log(`  [${Math.min(i + CHUNK_DAYS, dates.length)} / ${dates.length}] ${chunk[0]} .. ${chunk[chunk.length - 1]}`);
  }

  const [summary] = (await sql`
    SELECT COUNT(*)::int AS rows,
           COUNT(DISTINCT snapshot_date)::int AS days,
           MIN(snapshot_date)::text AS min_d,
           MAX(snapshot_date)::text AS max_d
    FROM gauntlet_daily_rollup
  `) as Array<Record<string, string>>;
  console.log(`\ngauntlet_daily_rollup: ${summary.rows} rows / ${summary.days} days (${summary.min_d} .. ${summary.max_d})`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

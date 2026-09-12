/**
 * `gauntlet_snapshots.share_price` / `usd_value` を `gauntlet_share_prices` から
 * 突合し直す修復スクリプト。Dune も外部 API も叩かない（クレジット消費ゼロ）。
 *
 * 使う場面: price 行より先に snapshots が入って `share_price = 1.0` のまま残った日
 * （Phase 15 / Phase 17 で発生）や、ingest 側の日付ずれで別日の価格が入った日。
 *
 *   npx tsx --env-file=.env.local scripts/repair-gauntlet-prices.ts --from 2026-08-22 --to 2026-09-11
 *   ... --dry-run   件数だけ数えて更新しない
 */
import { argv, exit } from 'node:process';
import { getDb } from '../lib/db';

function parseArgs() {
  let from: string | undefined;
  let to: string | undefined;
  let dryRun = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--dry-run') dryRun = true;
    else {
      console.error(`unknown argument: ${a}`);
      exit(1);
    }
  }
  const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(from) || !isDate(to)) {
    console.error('Usage: --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run]');
    exit(1);
  }
  return { from, to, dryRun };
}

async function main() {
  const { from, to, dryRun } = parseArgs();
  const sql = getDb({ unpooled: true });

  const days = (await sql`
    SELECT gs.snapshot_date::date::text AS d,
           COUNT(*)::int AS rows,
           COUNT(*) FILTER (
             WHERE gs.share_price IS DISTINCT FROM gp.share_price
                OR gs.usd_value IS DISTINCT FROM gs.shares * gp.share_price
           )::int AS wrong
    FROM gauntlet_snapshots gs
    JOIN gauntlet_share_prices gp ON gp.effective_date = gs.snapshot_date
    WHERE gs.snapshot_date BETWEEN ${from}::date AND ${to}::date
    GROUP BY gs.snapshot_date
    ORDER BY gs.snapshot_date
  `) as Array<{ d: string; rows: number; wrong: number }>;

  const totalWrong = days.reduce((a, r) => a + r.wrong, 0);
  console.log(`対象 ${days.length} 日 / 要修正 ${totalWrong} 行`);
  for (const r of days) {
    if (r.wrong > 0) console.log(`  ${r.d}: ${r.wrong} / ${r.rows} 行`);
  }

  if (dryRun) {
    console.log('dry-run のため更新しない');
    return;
  }
  if (totalWrong === 0) {
    console.log('修正対象なし');
    return;
  }

  // 1 日ずつ更新する。全期間を 1 文で更新すると dead tuple が一気に増えて
  // Neon の容量上限に当たりやすい（Phase 18）
  let done = 0;
  for (const [i, r] of days.entries()) {
    if (r.wrong === 0) continue;
    await sql`
      UPDATE gauntlet_snapshots gs
      SET share_price = gp.share_price,
          usd_value   = gs.shares * gp.share_price
      FROM gauntlet_share_prices gp
      WHERE gs.snapshot_date = gp.effective_date
        AND gs.snapshot_date = ${r.d}::date
        AND (gs.share_price IS DISTINCT FROM gp.share_price
             OR gs.usd_value IS DISTINCT FROM gs.shares * gp.share_price)
    `;
    done += r.wrong;
    console.log(`  [${i + 1} / ${days.length}] ${r.d} 修正 (${done} / ${totalWrong} 行)`);
  }

  const after = (await sql`
    SELECT gs.snapshot_date::date::text AS d,
           ROUND(SUM(gs.usd_value)::numeric, 2)::text AS tvl,
           MAX(gs.share_price)::text AS sp
    FROM gauntlet_snapshots gs
    WHERE gs.snapshot_date BETWEEN ${from}::date AND ${to}::date
    GROUP BY gs.snapshot_date
    ORDER BY gs.snapshot_date
  `) as Array<Record<string, string>>;
  console.log('\n修正後:');
  for (const r of after) console.log(`  ${r.d}: tvl=${r.tvl} sp=${r.sp}`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});

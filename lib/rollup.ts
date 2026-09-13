import type { NeonClient } from './db';

/**
 * Phase 19: `gauntlet_snapshots`（ホルダー明細）から日次集計を作り直す。
 *
 * グラフ / サマリはこの集計テーブルだけを読むので、明細を保持期間で削っても
 * 全期間の推移を描ける。明細が残っている日を対象に「その日を丸ごと」再計算する
 * 冪等な処理なので、ingest の途中で何度呼んでも最終値は同じになる。
 */

export const GAUNTLET_SCOPES = ['all', 'kast'] as const;
export type GauntletScope = (typeof GAUNTLET_SCOPES)[number];

/**
 * 指定日の集計を作り直す。明細が 1 行も無い日は集計行も作らない
 * （= 集計行の有無が「その日のデータを持っているか」を表す）。
 */
export async function refreshGauntletRollup(
  sql: NeonClient,
  dates: string[],
): Promise<{ dates: number }> {
  const unique = [...new Set(dates)].filter((d) => d.length > 0);
  if (unique.length === 0) return { dates: 0 };

  await sql`
    INSERT INTO gauntlet_daily_rollup (
      snapshot_date, scope, holders, total_usd,
      whale_100k_plus, large_10k_100k, mid_1k_10k, retail_100_1k, dust_lt_100,
      share_price, rolled_up_at
    )
    SELECT gs.snapshot_date,
           'all',
           COUNT(*)::int,
           COALESCE(SUM(gs.usd_value), 0),
           COALESCE(SUM(gs.usd_value) FILTER (WHERE gs.usd_value >= 100000), 0),
           COALESCE(SUM(gs.usd_value) FILTER (WHERE gs.usd_value >= 10000 AND gs.usd_value < 100000), 0),
           COALESCE(SUM(gs.usd_value) FILTER (WHERE gs.usd_value >= 1000  AND gs.usd_value < 10000 ), 0),
           COALESCE(SUM(gs.usd_value) FILTER (WHERE gs.usd_value >= 100   AND gs.usd_value < 1000  ), 0),
           COALESCE(SUM(gs.usd_value) FILTER (WHERE gs.usd_value < 100), 0),
           MAX(gs.share_price),
           now()
    FROM gauntlet_snapshots gs
    WHERE gs.snapshot_date = ANY(${unique}::date[])
    GROUP BY gs.snapshot_date
    ON CONFLICT (snapshot_date, scope) DO UPDATE SET
      holders         = excluded.holders,
      total_usd       = excluded.total_usd,
      whale_100k_plus = excluded.whale_100k_plus,
      large_10k_100k  = excluded.large_10k_100k,
      mid_1k_10k      = excluded.mid_1k_10k,
      retail_100_1k   = excluded.retail_100_1k,
      dust_lt_100     = excluded.dust_lt_100,
      share_price     = excluded.share_price,
      rolled_up_at    = excluded.rolled_up_at
  `;

  await sql`
    INSERT INTO gauntlet_daily_rollup (
      snapshot_date, scope, holders, total_usd,
      whale_100k_plus, large_10k_100k, mid_1k_10k, retail_100_1k, dust_lt_100,
      share_price, rolled_up_at
    )
    SELECT gs.snapshot_date,
           'kast',
           COUNT(*)::int,
           COALESCE(SUM(gs.usd_value), 0),
           COALESCE(SUM(gs.usd_value) FILTER (WHERE gs.usd_value >= 100000), 0),
           COALESCE(SUM(gs.usd_value) FILTER (WHERE gs.usd_value >= 10000 AND gs.usd_value < 100000), 0),
           COALESCE(SUM(gs.usd_value) FILTER (WHERE gs.usd_value >= 1000  AND gs.usd_value < 10000 ), 0),
           COALESCE(SUM(gs.usd_value) FILTER (WHERE gs.usd_value >= 100   AND gs.usd_value < 1000  ), 0),
           COALESCE(SUM(gs.usd_value) FILTER (WHERE gs.usd_value < 100), 0),
           MAX(gs.share_price),
           now()
    FROM gauntlet_snapshots gs
    INNER JOIN kast_base_wallets kbw ON kbw.wallet = gs.holder
    WHERE gs.snapshot_date = ANY(${unique}::date[])
    GROUP BY gs.snapshot_date
    ON CONFLICT (snapshot_date, scope) DO UPDATE SET
      holders         = excluded.holders,
      total_usd       = excluded.total_usd,
      whale_100k_plus = excluded.whale_100k_plus,
      large_10k_100k  = excluded.large_10k_100k,
      mid_1k_10k      = excluded.mid_1k_10k,
      retail_100_1k   = excluded.retail_100_1k,
      dust_lt_100     = excluded.dust_lt_100,
      share_price     = excluded.share_price,
      rolled_up_at    = excluded.rolled_up_at
  `;

  return { dates: unique.length };
}

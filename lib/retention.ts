import type { NeonClient } from './db';

/**
 * Phase 19.3.2 / 21.4: ホルダー明細 (`gauntlet_snapshots`) の保持期間管理。
 *
 * グラフとサマリは `gauntlet_daily_rollup` を読むので、明細を消しても全期間を描ける。
 * 明細が要るのは個別ウォレット検索と `/api/holders` だけ。
 */

/** 明細を何日ぶん残すか */
export const DETAIL_RETENTION_DAYS = 90;

/**
 * 保持期間より古い明細を 1 日ぶんだけ削除する。日次 cron から毎晩呼んで横ばいを維持する。
 * 集計行が無い日は消さない（消したら二度と作れないため）。
 */
export async function purgeOldestDetailDay(
  sql: NeonClient,
  retentionDays: number = DETAIL_RETENTION_DAYS,
): Promise<{ date: string | null; rows: number }> {
  const deleted = (await sql`
    WITH target AS (
      SELECT MIN(gs.snapshot_date) AS d
      FROM gauntlet_snapshots gs
      WHERE gs.snapshot_date < current_date - ${retentionDays}::int
        AND EXISTS (
          SELECT 1 FROM gauntlet_daily_rollup r
          WHERE r.snapshot_date = gs.snapshot_date AND r.scope = 'all'
        )
    )
    DELETE FROM gauntlet_snapshots
    WHERE snapshot_date = (SELECT d FROM target)
    RETURNING snapshot_date
  `) as Array<{ snapshot_date: Date | string }>;

  if (deleted.length === 0) return { date: null, rows: 0 };
  const d = deleted[0].snapshot_date;
  const date =
    typeof d === 'string'
      ? d.slice(0, 10)
      : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { date, rows: deleted.length };
}

-- Phase 19: Gauntlet の日次集計テーブル（明細の保持期間を絞るための前提）
--
-- グラフ / サマリが必要とするのは「日 × スコープ」の集計値だけで、
-- ホルダー明細 (gauntlet_snapshots) は個別ウォレット検索と /api/holders でしか使わない。
-- 集計を先に永続化しておけば、古い明細を削除してもグラフは全期間を描ける。
--
-- scope: 'all'  = 全ホルダー
--        'kast' = kast_base_wallets に載っているウォレットのみ（画面の KAST users only）
--        kast は「集計した時点の kast_base_wallets」で確定する点に注意。
CREATE TABLE IF NOT EXISTS gauntlet_daily_rollup (
  snapshot_date    date        NOT NULL,
  scope            text        NOT NULL,
  holders          int         NOT NULL,
  total_usd        numeric     NOT NULL DEFAULT 0,
  whale_100k_plus  numeric     NOT NULL DEFAULT 0,
  large_10k_100k   numeric     NOT NULL DEFAULT 0,
  mid_1k_10k       numeric     NOT NULL DEFAULT 0,
  retail_100_1k    numeric     NOT NULL DEFAULT 0,
  dust_lt_100      numeric     NOT NULL DEFAULT 0,
  share_price      numeric,
  rolled_up_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, scope),
  CONSTRAINT gauntlet_daily_rollup_scope_chk CHECK (scope IN ('all', 'kast'))
);

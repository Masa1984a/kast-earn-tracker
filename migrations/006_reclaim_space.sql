-- Phase 18: Neon 512 MB 上限到達への容量回収（データは削除しない）
--
-- gauntlet_snapshots の PRIMARY KEY は (snapshot_date, holder) で snapshot_date が
-- 先頭列なので、idx_gauntlet_date (snapshot_date) は完全に冗長。48 MB を回収する。
-- 戻す場合: CREATE INDEX idx_gauntlet_date ON gauntlet_snapshots (snapshot_date);
DROP INDEX IF EXISTS idx_gauntlet_date;

-- 一度も使われていない (pg_stat_user_indexes.idx_scan = 0)。約 0.3 MB。
-- 戻す場合: CREATE INDEX idx_kast_wallets_funded ON kast_base_wallets (first_funded_at);
DROP INDEX IF EXISTS idx_kast_wallets_funded;

-- 2 スキャンしか使われていない。約 0.3 MB。
-- 戻す場合: CREATE INDEX idx_tx_log_time ON usdky_tx_log (block_time);
DROP INDEX IF EXISTS idx_tx_log_time;

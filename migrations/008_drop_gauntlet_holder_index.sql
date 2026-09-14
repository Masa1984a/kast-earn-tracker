-- Phase 21: Neon が 512 MB に張り付き、VACUUM の FSM 拡張すら弾かれる状態を解くための緊急回収。
--
-- インデックスの DROP はファイルそのものを消すので pg_database_size が即座に減る
-- （DELETE / VACUUM では減らない）。
--
-- idx_gauntlet_holder は「日付条件なしの holder 検索」用。実際のクエリは
-- /api/snapshots も /api/holders も snapshot_date の範囲と一緒に holder を絞るため、
-- PK (snapshot_date, holder) で代替できる。明細を 90 日に絞った後は対象も 65 万行程度。
-- 戻す場合: CREATE INDEX idx_gauntlet_holder ON gauntlet_snapshots (holder);
DROP INDEX IF EXISTS idx_gauntlet_holder;

-- usdky_snapshots の PK は (snapshot_date, owner) なので日付単独インデックスは冗長
-- 戻す場合: CREATE INDEX idx_snapshots_date ON usdky_snapshots (snapshot_date);
DROP INDEX IF EXISTS idx_snapshots_date;

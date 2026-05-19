-- USDKY Holders Tracker — initial schema
-- See usdky-tracker-spec.md §3 for the source of truth.

-- 日次snapshot（メインテーブル）
CREATE TABLE IF NOT EXISTS usdky_snapshots (
  snapshot_date date    NOT NULL,
  owner         text    NOT NULL,
  principal     numeric NOT NULL,
  multiplier    numeric NOT NULL,
  usd_value     numeric NOT NULL,
  ata_count     int     NOT NULL DEFAULT 1,
  PRIMARY KEY (snapshot_date, owner)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_date  ON usdky_snapshots (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_owner ON usdky_snapshots (owner);

-- multiplier履歴（日付 → その日のmultiplier）
CREATE TABLE IF NOT EXISTS usdky_multipliers (
  effective_date date        PRIMARY KEY,
  multiplier     numeric     NOT NULL,
  block_time     timestamptz NOT NULL,
  signature      text        NOT NULL
);

-- 生トランザクションログ（再集計用、デバッグ用）
CREATE TABLE IF NOT EXISTS usdky_tx_log (
  signature   text        PRIMARY KEY,
  block_time  timestamptz NOT NULL,
  owner       text        NOT NULL,
  delta       numeric     NOT NULL,
  kind        text        NOT NULL  -- 'mint' | 'burn' | 'transfer'
);
CREATE INDEX IF NOT EXISTS idx_tx_log_time  ON usdky_tx_log (block_time);
CREATE INDEX IF NOT EXISTS idx_tx_log_owner ON usdky_tx_log (owner);

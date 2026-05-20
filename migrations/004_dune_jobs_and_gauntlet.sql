-- Phase 9: Gauntlet Alpha Vault 統合（非同期ジョブ + share_price 対応版）
-- 仕様: gauntlet-extension.md

CREATE TABLE IF NOT EXISTS dune_jobs (
  id              serial      PRIMARY KEY,
  query_id        int         NOT NULL,
  params          jsonb       NOT NULL,
  execution_id    text,
  status          text        NOT NULL,
  rows_count      int,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  job_kind        text        NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dune_jobs_active
  ON dune_jobs (status, started_at)
  WHERE status IN ('queued', 'executing');

CREATE INDEX IF NOT EXISTS idx_dune_jobs_kind_date
  ON dune_jobs (job_kind, created_at DESC);

CREATE TABLE IF NOT EXISTS gauntlet_snapshots (
  snapshot_date date    NOT NULL,
  holder        text    NOT NULL,
  shares        numeric NOT NULL,
  share_price   numeric NOT NULL DEFAULT 1.0,
  usd_value     numeric NOT NULL,
  chain         text    NOT NULL DEFAULT 'base',
  PRIMARY KEY (snapshot_date, holder)
);

CREATE INDEX IF NOT EXISTS idx_gauntlet_date   ON gauntlet_snapshots (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_gauntlet_holder ON gauntlet_snapshots (holder);

CREATE TABLE IF NOT EXISTS gauntlet_share_prices (
  effective_date     date     PRIMARY KEY,
  share_price        numeric  NOT NULL,
  enter_events_today int      NOT NULL DEFAULT 0,
  daily_volume_usdc  numeric  NOT NULL DEFAULT 0,
  source             text     NOT NULL DEFAULT 'dune_enter_event'
);

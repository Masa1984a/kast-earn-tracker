-- Phase 10: KAST users filter (Bybit OTC signature)
-- 仕様: phase10-kast-filter.md
-- Dune query 7544316 が返す KAST-funded gtUSDa Alpha holders を保持する

CREATE TABLE IF NOT EXISTS kast_base_wallets (
  wallet           text        PRIMARY KEY,
  first_funded_at  timestamptz NOT NULL,
  last_updated_at  timestamptz NOT NULL DEFAULT now(),
  source           text        NOT NULL DEFAULT 'bybit_otc_signature'
);

CREATE INDEX IF NOT EXISTS idx_kast_wallets_funded
  ON kast_base_wallets (first_funded_at);

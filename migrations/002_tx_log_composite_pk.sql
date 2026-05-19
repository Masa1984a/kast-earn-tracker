-- One USDKY tx (transferChecked) produces deltas for two owners (source + destination).
-- The spec's single-column PK on signature can't represent that, so widen to (signature, owner).

ALTER TABLE usdky_tx_log DROP CONSTRAINT IF EXISTS usdky_tx_log_pkey;
ALTER TABLE usdky_tx_log ADD PRIMARY KEY (signature, owner);

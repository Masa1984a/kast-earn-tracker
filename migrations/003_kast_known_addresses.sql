CREATE TABLE IF NOT EXISTS kast_known_addresses (
  address  text PRIMARY KEY,
  label    text NOT NULL,  -- 'treasury' | 'infra' | 'bridge' | etc.
  note     text,
  added_at timestamptz DEFAULT now()
);

INSERT INTO kast_known_addresses (address, label, note) VALUES
  ('5WVYUVeJvcwD4Fpko5aZgdoB346Ef9ioAG6znohbrbti', 'treasury', '10 mints / net 0 USDKY / sole issuance hub for all 1.81M USDKY supply'),
  ('EGzpN9QTKLNT7eoLyqy2f8FRvq9krNpbVMP98Yqscf7z', 'infra',    '1627 transfer txs / likely DEX / pool / custodial aggregator'),
  ('E1vwo1VpXafBEPe8Tn2Ps2qLgywS9rfTR97fXc5RCW2a', 'infra',    '1055 transfer txs / likely DEX / pool / custodial aggregator')
ON CONFLICT (address) DO NOTHING;

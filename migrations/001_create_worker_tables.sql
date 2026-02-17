-- Create worker_chain_state table
CREATE TABLE IF NOT EXISTS worker_chain_state (
  chain_id UUID PRIMARY KEY REFERENCES chains(id),
  last_processed_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create deposits table
CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id UUID NOT NULL REFERENCES chains(id),
  asset_on_chain_id UUID NOT NULL REFERENCES asset_on_chain(id),
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  amount_human NUMERIC NOT NULL,
  block_number BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT deposits_tx_hash_log_index_unique UNIQUE (tx_hash, log_index)
);

-- Create indices for performance
CREATE INDEX IF NOT EXISTS idx_deposits_chain_id ON deposits(chain_id);
CREATE INDEX IF NOT EXISTS idx_deposits_asset_on_chain_id ON deposits(asset_on_chain_id);
CREATE INDEX IF NOT EXISTS idx_deposits_to_address ON deposits(to_address);
CREATE INDEX IF NOT EXISTS idx_deposits_block_number ON deposits(block_number);
CREATE INDEX IF NOT EXISTS idx_deposits_created_at ON deposits(created_at);


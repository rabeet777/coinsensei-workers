-- Add last_used_at column to operation_wallets for round-robin routing

ALTER TABLE operation_wallets 
ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Create index for efficient hot wallet selection
-- This index is used by rule execution worker for round-robin routing
CREATE INDEX IF NOT EXISTS idx_operation_wallets_routing
ON operation_wallets(chain_id, purpose, is_active, last_used_at)
WHERE is_active = true;

-- Partial index specifically for hot wallet selection
CREATE INDEX IF NOT EXISTS idx_operation_wallets_hot_selection
ON operation_wallets(chain_id, last_used_at)
WHERE is_active = true AND purpose = 'hot';

-- Add comment
COMMENT ON COLUMN operation_wallets.last_used_at IS 'Timestamp of last use for deterministic round-robin routing (updated by rule execution worker)';


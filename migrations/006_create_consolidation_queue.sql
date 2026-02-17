-- =====================================================
-- Migration: Create consolidation_queue table
-- =====================================================

CREATE TABLE IF NOT EXISTS consolidation_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Chain and wallet info
  chain_id UUID NOT NULL REFERENCES chains(id),
  wallet_id UUID NOT NULL,  -- References user_wallet_addresses.id
  wallet_balance_id UUID NOT NULL,  -- References wallet_balances.id
  
  -- Destination (hot wallet)
  operation_wallet_address_id UUID NOT NULL,  -- References operation_wallet_addresses.id
  
  -- Amount to consolidate
  amount_raw TEXT NOT NULL,
  amount_human TEXT NOT NULL,
  
  -- Job metadata
  status TEXT NOT NULL DEFAULT 'pending',
  -- Possible statuses: 'pending', 'processing', 'confirming', 'confirmed', 'failed', 'cancelled'
  
  priority TEXT NOT NULL DEFAULT 'normal',
  -- Possible priorities: 'low', 'normal', 'high'
  
  reason TEXT,
  rule_id UUID,  -- Optional: references consolidation_rules.id if applicable
  
  -- Transaction tracking
  tx_hash TEXT,
  
  -- Retry and error tracking
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  
  -- Timestamps
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Unique constraint: one pending/processing job per wallet_balance
  CONSTRAINT consolidation_queue_wallet_balance_unique UNIQUE (wallet_balance_id, status)
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_consolidation_queue_status ON consolidation_queue(status);
CREATE INDEX IF NOT EXISTS idx_consolidation_queue_chain_id ON consolidation_queue(chain_id);
CREATE INDEX IF NOT EXISTS idx_consolidation_queue_wallet_id ON consolidation_queue(wallet_id);
CREATE INDEX IF NOT EXISTS idx_consolidation_queue_scheduled_at ON consolidation_queue(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_consolidation_queue_priority ON consolidation_queue(priority);

-- Partial unique index for pending/processing statuses only
DROP INDEX IF EXISTS idx_consolidation_queue_wallet_balance_unique;
CREATE UNIQUE INDEX idx_consolidation_queue_wallet_balance_unique 
  ON consolidation_queue(wallet_balance_id) 
  WHERE status IN ('pending', 'processing', 'confirming');

-- Add comment
COMMENT ON TABLE consolidation_queue IS 'Queue for consolidation jobs created by rule execution worker';


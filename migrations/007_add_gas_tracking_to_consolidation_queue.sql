-- =====================================================
-- Migration: Add gas tracking to consolidation_queue
-- =====================================================

-- Add gas tracking columns
ALTER TABLE consolidation_queue
  ADD COLUMN IF NOT EXISTS gas_used BIGINT,
  ADD COLUMN IF NOT EXISTS gas_price TEXT;

-- Add comment
COMMENT ON COLUMN consolidation_queue.gas_used IS 'Gas used by the consolidation transaction';
COMMENT ON COLUMN consolidation_queue.gas_price IS 'Gas price of the consolidation transaction (in wei/sun)';


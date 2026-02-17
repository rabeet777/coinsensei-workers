-- =====================================================
-- Migration: Refactor Withdrawal Schema
-- Purpose: Separate USER INTENT from BLOCKCHAIN EXECUTION
-- =====================================================

-- =====================================================
-- PART 1 — Refactor withdrawal_requests (Intent Layer)
-- =====================================================

-- This table represents USER INTENT, approval state, and UI concerns.
-- It must NOT contain blockchain execution details.

COMMENT ON TABLE withdrawal_requests IS 'User withdrawal intent, approval state, and lifecycle tracking';

-- ----------------------------
-- REMOVE EXECUTION-SPECIFIC COLUMNS
-- ----------------------------

-- These columns are moving to withdrawal_queue because they belong
-- to blockchain execution, not user intent.

ALTER TABLE withdrawal_requests
DROP COLUMN IF EXISTS wallet_id CASCADE,
DROP COLUMN IF EXISTS fees_raw CASCADE,
DROP COLUMN IF EXISTS processing_fee_raw CASCADE,
DROP COLUMN IF EXISTS tx_hash CASCADE,
DROP COLUMN IF EXISTS gas_tx_hash CASCADE,
DROP COLUMN IF EXISTS processed_at CASCADE,
DROP COLUMN IF EXISTS error_message CASCADE;

-- ----------------------------
-- ADD INTENT LIFECYCLE FIELDS
-- ----------------------------

-- Track when execution job was created (prevents duplicate jobs)
ALTER TABLE withdrawal_requests
ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;

-- Store final confirmed transaction hash (for UI/support reference)
ALTER TABLE withdrawal_requests
ADD COLUMN IF NOT EXISTS final_tx_hash VARCHAR(100);

-- ----------------------------
-- STATUS LIFECYCLE (DOCUMENTATION)
-- ----------------------------

-- withdrawal_requests.status represents ONLY intent state:
--
-- 'pending'    → user submitted, awaiting approval
-- 'approved'   → admin/system approved, ready to queue
-- 'queued'     → execution job created in withdrawal_queue
-- 'completed'  → confirmed on-chain (final_tx_hash set)
-- 'failed'     → terminal failure (no retry possible)
--
-- No enum constraint - maintained by application logic

-- Add comment to status column
COMMENT ON COLUMN withdrawal_requests.status IS 'Intent lifecycle: pending → approved → queued → completed / failed';
COMMENT ON COLUMN withdrawal_requests.queued_at IS 'Timestamp when execution job was created in withdrawal_queue';
COMMENT ON COLUMN withdrawal_requests.final_tx_hash IS 'Final confirmed transaction hash (for UI/support)';

-- ----------------------------
-- EXISTING TRIGGERS (UNCHANGED)
-- ----------------------------

-- The following triggers remain active and unchanged:
-- 1. enqueue_notification_crypto_withdrawal (notify backend)
-- 2. handle_withdrawal_status_change (audit log)

-- =====================================================
-- PART 2 — Create withdrawal_queue (Execution Layer)
-- =====================================================

-- This table represents BLOCKCHAIN EXECUTION JOBS ONLY.
-- One row = one execution attempt with full retry capability.

CREATE TABLE IF NOT EXISTS public.withdrawal_queue (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References
  withdrawal_request_id UUID NOT NULL,
  chain_id UUID NOT NULL,
  asset_on_chain_id UUID NOT NULL,
  operation_wallet_address_id UUID NOT NULL,

  -- Execution details
  to_address VARCHAR(100) NOT NULL,
  amount_raw TEXT NOT NULL,
  amount_human NUMERIC(28,18) NOT NULL,

  -- Job state
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',

  -- Transaction tracking
  tx_hash VARCHAR(100),
  gas_used TEXT,
  gas_price TEXT,

  -- Retry management
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 5,

  -- Error tracking
  error_message TEXT,

  -- Timestamps
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Foreign key constraints
  CONSTRAINT fk_withdrawal_queue_request
    FOREIGN KEY (withdrawal_request_id)
    REFERENCES withdrawal_requests(id)
    ON DELETE CASCADE,

  CONSTRAINT fk_withdrawal_queue_chain
    FOREIGN KEY (chain_id)
    REFERENCES chains(id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_withdrawal_queue_asset
    FOREIGN KEY (asset_on_chain_id)
    REFERENCES asset_on_chain(id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_withdrawal_queue_operation_wallet
    FOREIGN KEY (operation_wallet_address_id)
    REFERENCES operation_wallet_addresses(id)
    ON DELETE RESTRICT
);

-- ----------------------------
-- INDEXES FOR PERFORMANCE
-- ----------------------------

-- Status-based job picking
CREATE INDEX IF NOT EXISTS idx_withdrawal_queue_status
ON withdrawal_queue (status);

-- Chain-specific queries
CREATE INDEX IF NOT EXISTS idx_withdrawal_queue_chain
ON withdrawal_queue (chain_id);

-- Priority-based sorting
CREATE INDEX IF NOT EXISTS idx_withdrawal_queue_priority
ON withdrawal_queue (priority);

-- Scheduled job selection
CREATE INDEX IF NOT EXISTS idx_withdrawal_queue_scheduled
ON withdrawal_queue (scheduled_at);

-- Composite index for job picking
CREATE INDEX IF NOT EXISTS idx_withdrawal_queue_job_picking
ON withdrawal_queue (chain_id, status, priority, scheduled_at)
WHERE status IN ('pending', 'processing');

-- Lookup by withdrawal request
CREATE INDEX IF NOT EXISTS idx_withdrawal_queue_request
ON withdrawal_queue (withdrawal_request_id);

-- Transaction hash lookup
CREATE INDEX IF NOT EXISTS idx_withdrawal_queue_tx_hash
ON withdrawal_queue (tx_hash)
WHERE tx_hash IS NOT NULL;

-- ----------------------------
-- UNIQUENESS CONSTRAINT
-- ----------------------------

-- Ensure ONLY ONE active execution job exists per withdrawal request.
-- This prevents duplicate blockchain transactions.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_withdrawal_queue_active
ON withdrawal_queue (withdrawal_request_id)
WHERE status IN ('pending', 'processing');

-- ----------------------------
-- TABLE COMMENTS
-- ----------------------------

COMMENT ON TABLE withdrawal_queue IS 'Blockchain execution jobs for approved withdrawals';

COMMENT ON COLUMN withdrawal_queue.id IS 'Unique job identifier';
COMMENT ON COLUMN withdrawal_queue.withdrawal_request_id IS 'Reference to user withdrawal intent';
COMMENT ON COLUMN withdrawal_queue.chain_id IS 'Target blockchain for execution';
COMMENT ON COLUMN withdrawal_queue.asset_on_chain_id IS 'Asset to send (native or token)';
COMMENT ON COLUMN withdrawal_queue.operation_wallet_address_id IS 'Hot wallet sending the funds (deterministically selected)';
COMMENT ON COLUMN withdrawal_queue.to_address IS 'Destination address (user wallet)';
COMMENT ON COLUMN withdrawal_queue.amount_raw IS 'Amount in smallest unit (wei/sun)';
COMMENT ON COLUMN withdrawal_queue.amount_human IS 'Human-readable amount';
COMMENT ON COLUMN withdrawal_queue.status IS 'Execution state: pending → processing → confirming → confirmed / failed';
COMMENT ON COLUMN withdrawal_queue.priority IS 'Job priority: low, normal, high';
COMMENT ON COLUMN withdrawal_queue.tx_hash IS 'Blockchain transaction hash (set after broadcast)';
COMMENT ON COLUMN withdrawal_queue.gas_used IS 'Gas consumed by transaction';
COMMENT ON COLUMN withdrawal_queue.gas_price IS 'Gas price paid (wei/sun)';
COMMENT ON COLUMN withdrawal_queue.retry_count IS 'Number of retry attempts';
COMMENT ON COLUMN withdrawal_queue.max_retries IS 'Maximum retry attempts before marking failed';
COMMENT ON COLUMN withdrawal_queue.error_message IS 'Last error encountered';
COMMENT ON COLUMN withdrawal_queue.scheduled_at IS 'When the job should be executed (for backoff)';
COMMENT ON COLUMN withdrawal_queue.processed_at IS 'When the job was finalized (confirmed or failed)';
COMMENT ON COLUMN withdrawal_queue.created_at IS 'When the job was created';

-- =====================================================
-- EXECUTION STATUS LIFECYCLE (DOCUMENTATION)
-- =====================================================

-- withdrawal_queue.status represents ONLY execution state:
--
-- 'pending'      → awaiting worker pickup
-- 'processing'   → worker building/signing transaction
-- 'confirming'   → transaction broadcasted, awaiting confirmations
-- 'confirmed'    → transaction confirmed on-chain
-- 'failed'       → terminal failure (max retries or permanent error)
--
-- Workers must follow this state machine strictly.

-- =====================================================
-- MIGRATION VALIDATION QUERIES
-- =====================================================

-- To verify migration success, run:
--
-- 1. Check withdrawal_requests columns:
--    SELECT column_name, data_type
--    FROM information_schema.columns
--    WHERE table_name = 'withdrawal_requests'
--    ORDER BY ordinal_position;
--
-- 2. Check withdrawal_queue structure:
--    SELECT column_name, data_type
--    FROM information_schema.columns
--    WHERE table_name = 'withdrawal_queue'
--    ORDER BY ordinal_position;
--
-- 3. Verify indexes:
--    SELECT indexname, indexdef
--    FROM pg_indexes
--    WHERE tablename = 'withdrawal_queue';
--
-- 4. Verify foreign keys:
--    SELECT conname, conrelid::regclass, confrelid::regclass
--    FROM pg_constraint
--    WHERE conrelid = 'withdrawal_queue'::regclass;

-- =====================================================
-- END OF MIGRATION
-- =====================================================


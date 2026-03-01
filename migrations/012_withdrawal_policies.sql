-- =====================================================
-- Migration: Withdrawal policies and risk engine support
-- Purpose: Policy table keyed by asset_on_chain_id; optional metadata/updated_at on withdrawal_requests; claim function for risk engine
-- =====================================================

-- =====================================================
-- PART 1 — withdrawal_policies table
-- =====================================================

CREATE TABLE IF NOT EXISTS public.withdrawal_policies (
  asset_on_chain_id UUID PRIMARY KEY REFERENCES asset_on_chain(id) ON DELETE CASCADE,
  auto_approve_limit NUMERIC(28,18) NOT NULL,
  dual_approval_limit NUMERIC(28,18) NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  bulk_max_count INTEGER NULL,
  bulk_max_total_amount NUMERIC(28,18) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE withdrawal_policies IS 'Risk policies per asset_on_chain for withdrawal auto-approval and dual-approval thresholds';
COMMENT ON COLUMN withdrawal_policies.asset_on_chain_id IS 'FK to asset_on_chain; one policy per asset-on-chain';
COMMENT ON COLUMN withdrawal_policies.auto_approve_limit IS 'Amount (human): <= this -> approved by risk engine';
COMMENT ON COLUMN withdrawal_policies.dual_approval_limit IS 'Amount (human): > this -> manual_review and requires_dual_approval';
COMMENT ON COLUMN withdrawal_policies.is_enabled IS 'If false, all requests for this asset go to manual_review';
COMMENT ON COLUMN withdrawal_policies.bulk_max_count IS 'Reserved for future bulk rules';
COMMENT ON COLUMN withdrawal_policies.bulk_max_total_amount IS 'Reserved for future bulk rules';

CREATE INDEX IF NOT EXISTS idx_withdrawal_policies_is_enabled
  ON withdrawal_policies(is_enabled)
  WHERE is_enabled = true;

-- updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_withdrawal_policies_updated_at ON withdrawal_policies;
CREATE TRIGGER tr_withdrawal_policies_updated_at
  BEFORE UPDATE ON withdrawal_policies
  FOR EACH ROW
  EXECUTE PROCEDURE set_updated_at();

-- =====================================================
-- PART 2 — withdrawal_requests: ensure metadata column
-- =====================================================
-- Risk engine writes metadata.risk (jsonb). If metadata column does not exist, add it.

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

COMMENT ON COLUMN withdrawal_requests.metadata IS 'Optional JSON; risk engine stores metadata.risk = { version, type, evaluated_at, policy, chain_active, decision, requires_dual_approval, reason }';

-- status 'risk_processing' is valid (varchar, no enum) — no DDL change needed.

-- =====================================================
-- PART 3 — Claim function for concurrency-safe batch claim
-- =====================================================
-- Claims up to limit_count rows from pending -> risk_processing using FOR UPDATE SKIP LOCKED.
-- Returns the claimed rows for processing.

CREATE OR REPLACE FUNCTION claim_pending_withdrawal_requests_for_risk(limit_count INTEGER)
RETURNS SETOF withdrawal_requests
LANGUAGE plpgsql
AS $$
DECLARE
  id_list UUID[];
BEGIN
  IF limit_count IS NULL OR limit_count < 1 THEN
    RETURN;
  END IF;

  SELECT ARRAY_AGG(id ORDER BY id ASC)
  INTO id_list
  FROM (
    SELECT id
    FROM withdrawal_requests
    WHERE status = 'pending'
    ORDER BY id ASC
    LIMIT limit_count
    FOR UPDATE SKIP LOCKED
  ) sub;

  IF id_list IS NULL OR array_length(id_list, 1) IS NULL THEN
    RETURN;
  END IF;

  UPDATE withdrawal_requests
  SET status = 'risk_processing',
      updated_at = NOW()
  WHERE id = ANY(id_list)
    AND status = 'pending';

  RETURN QUERY
  SELECT *
  FROM withdrawal_requests
  WHERE id = ANY(id_list);
END;
$$;

COMMENT ON FUNCTION claim_pending_withdrawal_requests_for_risk(Integer) IS
  'Claims pending withdrawal_requests to risk_processing; returns claimed rows. Use from withdrawal-risk-engine worker only.';

-- =====================================================
-- SAMPLE SEED (template — replace asset_on_chain_id with real UUIDs)
-- =====================================================
--
-- USDT TRC20: get asset_on_chain_id from asset_on_chain where chain = tron and asset = USDT
-- USDT BEP20: get asset_on_chain_id from asset_on_chain where chain = bsc and asset = USDT
--
-- INSERT INTO withdrawal_policies (asset_on_chain_id, auto_approve_limit, dual_approval_limit, is_enabled)
-- VALUES
--   ('<USDT_TRC20_ASSET_ON_CHAIN_ID>', 1000, 10000, true),
--   ('<USDT_BEP20_ASSET_ON_CHAIN_ID>', 1000, 10000, true)
-- ON CONFLICT (asset_on_chain_id) DO UPDATE SET
--   auto_approve_limit = EXCLUDED.auto_approve_limit,
--   dual_approval_limit = EXCLUDED.dual_approval_limit,
--   is_enabled = EXCLUDED.is_enabled,
--   updated_at = NOW();

-- =====================================================
-- END OF MIGRATION
-- =====================================================

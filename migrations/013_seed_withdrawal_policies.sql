-- =====================================================
-- Migration: Seed withdrawal policies for USDT TRC20 and USDT BEP20
-- Run after 012_withdrawal_policies.sql
-- =====================================================

INSERT INTO withdrawal_policies (asset_on_chain_id, auto_approve_limit, dual_approval_limit, is_enabled)
SELECT aoc.id, 1000, 10000, true
FROM asset_on_chain aoc
JOIN chains c ON aoc.chain_id = c.id
JOIN assets a ON aoc.asset_id = a.id
WHERE LOWER(c.name) = 'tron' AND UPPER(COALESCE(a.symbol, '')) = 'USDT'
ON CONFLICT (asset_on_chain_id) DO UPDATE SET
  auto_approve_limit = EXCLUDED.auto_approve_limit,
  dual_approval_limit = EXCLUDED.dual_approval_limit,
  is_enabled = EXCLUDED.is_enabled,
  updated_at = NOW();

INSERT INTO withdrawal_policies (asset_on_chain_id, auto_approve_limit, dual_approval_limit, is_enabled)
SELECT aoc.id, 1000, 10000, true
FROM asset_on_chain aoc
JOIN chains c ON aoc.chain_id = c.id
JOIN assets a ON aoc.asset_id = a.id
WHERE LOWER(c.name) = 'bsc' AND UPPER(COALESCE(a.symbol, '')) = 'USDT'
ON CONFLICT (asset_on_chain_id) DO UPDATE SET
  auto_approve_limit = EXCLUDED.auto_approve_limit,
  dual_approval_limit = EXCLUDED.dual_approval_limit,
  is_enabled = EXCLUDED.is_enabled,
  updated_at = NOW();

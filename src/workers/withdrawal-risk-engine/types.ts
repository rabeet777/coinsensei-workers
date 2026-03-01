/**
 * Types for withdrawal-risk-engine worker.
 * Risk engine only updates withdrawal_requests; it does not touch withdrawal_queue.
 */

export interface WithdrawalRequestRow {
  id: string;
  user_id: string;
  chain_id: string;
  asset_on_chain_id: string | null;
  asset_id?: string | null;
  amount_human: number | null;
  amount?: number | null;
  to_address: string;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
  queued_at?: string | null;
  [key: string]: unknown;
}

export interface WithdrawalPolicyRow {
  asset_on_chain_id: string;
  auto_approve_limit: string;
  dual_approval_limit: string;
  is_enabled: boolean;
  bulk_max_count: number | null;
  bulk_max_total_amount: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChainRow {
  id: string;
  is_active: boolean;
}

export type RiskDecision = 'approved' | 'manual_review';

export interface RiskEvaluationResult {
  version: 1;
  type: 'amount_only';
  evaluated_at: string;
  policy: {
    auto_approve_limit: number;
    dual_approval_limit: number;
  };
  chain_active: boolean;
  decision: RiskDecision;
  requires_dual_approval: boolean;
  reason: string;
}

export const RISK_METADATA_KEY = 'risk';

/**
 * Gas Top-Up Queue Types
 * Shared interfaces for gas top-up queue operations
 */

export type GasTopupStatus =
  | 'queued'
  | 'picked'
  | 'building_tx'
  | 'signing'
  | 'broadcasting'
  | 'broadcasted'
  | 'confirming'
  | 'confirmed'
  | 'failed_retryable'
  | 'failed_final'
  | 'cancelled';

export interface GasTopupJob {
  id: string;
  chain_id: string;
  wallet_id: string;
  operation_wallet_address_id: string;
  gas_asset_id: string;
  topup_amount_raw: string | null;
  topup_amount_human: string;
  priority: number;
  status: string;
  reason: string | null;
  rule_id: string | null;
  
  // Transaction tracking
  tx_hash: string | null;
  
  // Retry & Error tracking
  retry_count: number;
  error_message: string | null;
  
  // Timestamps
  created_at: string;
  updated_at: string;
  scheduled_at: string;
  processed_at: string | null;
}

export interface OperationWalletAddress {
  id: string;
  chain_id: string;
  role: string;
  wallet_group_id: string;
  derivation_index: number;
  address: string;
  is_active: boolean;
  last_used_at: string | null;
}

export interface SignerRequest {
  chain: string;
  wallet_group_id: string;
  derivation_index: number;
  unsigned_tx?: any; // BSC: hex string (for EVM chains)
  tx_intent?: { type: string; from: string; to: string; amount_sun: string }; // TRON: transaction intent
}

export interface SignerResponse {
  signed_tx: string;
  tx_hash: string;
}


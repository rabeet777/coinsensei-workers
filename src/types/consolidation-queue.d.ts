export type ConsolidationStatus = 'pending' | 'processing' | 'confirming' | 'confirmed' | 'failed' | 'cancelled';
export type ConsolidationPriority = 'low' | 'normal' | 'high';
export interface ConsolidationJob {
    id: string;
    chain_id: string;
    wallet_id: string;
    wallet_balance_id: string;
    operation_wallet_address_id: string;
    amount_raw: string;
    amount_human: string;
    status: ConsolidationStatus;
    priority: ConsolidationPriority;
    reason?: string | null;
    rule_id?: string | null;
    tx_hash?: string | null;
    retry_count: number;
    error_message?: string | null;
    scheduled_at: string;
    processed_at?: string | null;
    gas_used?: number | null;
    gas_price?: string | null;
    created_at: string;
    updated_at: string;
}
export interface WalletBalanceValidation {
    id: string;
    needs_consolidation: boolean;
    needs_gas: boolean;
    processing_status: string;
    consolidation_locked_until?: string | null;
    consolidation_locked_by?: string | null;
}
export interface OperationWalletAddress {
    id: string;
    chain_id: string;
    role: string;
    address: string;
    wallet_group_id: string;
    derivation_index: number;
    is_active: boolean;
}
//# sourceMappingURL=consolidation-queue.d.ts.map
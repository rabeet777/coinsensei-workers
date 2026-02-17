export declare class TronGasTopupWorker {
    private supabase;
    private signerService;
    private runtime;
    private isRunning;
    private stopHeartbeat;
    private readonly GAS_LOCK_DURATION_MINUTES;
    private readonly POLL_INTERVAL_MS;
    private readonly MAX_RETRIES;
    private readonly CONFIRMATION_BLOCKS;
    private readonly FEE_LIMIT;
    private readonly CONFIRM_RETRY_DELAY_MS;
    private rpcUrl;
    private chainId;
    constructor();
    get WORKER_ID(): string;
    /**
     * Initialize worker
     */
    initialize(): Promise<void>;
    /**
     * Process batch of gas top-up jobs
     * Jobs are picked one at a time to ensure proper gas locking
     */
    processBatch(): Promise<void>;
    /**
     * Pick next job from gas_topup_queue
     * A) Fetch 25 candidates, sort in code by priority, pick first
     * B) NO row-level locking here - locking happens at wallet_balances level
     */
    private pickNextJob;
    /**
     * Process job with wallet-level gas locking
     * CRITICAL: Gas lock must be acquired at wallet_balances level, not job level
     * NOTE: Jobs in 'confirming' state should NOT acquire gas lock - confirmation worker handles them
     */
    private processJobWithGasLock;
    /**
     * Acquire gas lock at wallet_balances level
     * C) GAS LOCK ACQUIRE (CRITICAL)
     * - Resolve native gas asset_on_chain_id by joining asset_on_chain
     * - Find asset_on_chain_id WHERE chain_id=job.chain_id AND asset_id=job.gas_asset_id
     * - Returns true if lock acquired, false if another worker owns it
     */
    private acquireGasLock;
    /**
     * Release gas lock at wallet_balances level
     * H) RELEASE GAS LOCK (ALWAYS) - In finally block
     */
    private releaseGasLock;
    /**
     * Process a single gas top-up job through state machine
     */
    private processJob;
    /**
     * Execute a new gas top-up job
     */
    private executeNewJob;
    /**
     * Load operation wallet address (funding wallet)
     * E) FUNDING WALLET RESOLUTION (AUTHORITATIVE)
     * - Load from operation_wallet_addresses by id = job.operation_wallet_address_id AND chain_id = job.chain_id AND is_active = true
     * - Use (address, wallet_group_id, derivation_index)
     */
    private loadOperationWalletAddress;
    /**
     * Load target wallet address from user_wallet_addresses
     * D) TARGET ADDRESS RESOLUTION (CORRECT)
     * - gas_topup_queue.wallet_id corresponds to user_wallet_addresses.id (NOT uid)
     * - SELECT address, uid, chain_id, wallet_group_id, derivation_index
     * - FROM user_wallet_addresses WHERE id = job.wallet_id AND chain_id = job.chain_id AND is_active = true
     */
    private loadTargetWalletAddress;
    /**
     * Validate funding wallet has sufficient balance
     * NOTE: Balance validation is now handled by signer service
     * This method is kept for compatibility but does not perform actual validation
     */
    private validateFundingBalance;
    /**
     * Build transaction intent for signer service
     * Signer service is responsible for building the transaction
     * Returns: type, from, to, amount_sun
     */
    private buildTransactionIntent;
    /**
     * FIX 6: ERROR CLASSIFICATION - Minimal classification for TRON
     */
    private classifyTronError;
    /**
     * Update wallet gas state after successful top-up
     */
    private updateWalletGasState;
    /**
     * Write audit record (internal ledger)
     */
    private writeAuditRecord;
    /**
     * Update job status in gas_topup_queue
     * FIX 1: Only update valid columns: status, processed_at (if confirmed/failed)
     */
    private updateJobStatus;
    /**
     * Update job with tx_hash
     * FIX 1: Only update valid columns: tx_hash, status
     */
    private updateJobTxHash;
    /**
     * Handle job error with retry backoff policy
     * G) RETRY / BACKOFF
     * - MAX_RETRIES=8
     * - Backoff = min(2^retry_count * 30 seconds, 15 minutes)
     * - On retryable error: increment retry_count, set error_message, scheduled_at, status='pending', release gas lock
     * - If retry_count >= MAX_RETRIES: status='failed', processed_at=now(), release gas lock
     */
    private handleJobError;
    /**
     * Start worker loop
     */
    start(): Promise<void>;
    /**
     * Stop worker
     */
    stop(): void;
}
//# sourceMappingURL=tron-gas-topup.worker.d.ts.map
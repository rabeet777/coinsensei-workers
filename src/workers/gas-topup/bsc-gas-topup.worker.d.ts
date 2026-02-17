export declare class BscGasTopupWorker {
    private supabase;
    private provider;
    private signerService;
    private runtime;
    private isRunning;
    private stopHeartbeat;
    private readonly GAS_LOCK_DURATION_MINUTES;
    private readonly POLL_INTERVAL_MS;
    private readonly MAX_RETRIES;
    private readonly CONFIRMATION_BLOCKS;
    private readonly GAS_LIMIT;
    private readonly MAX_GAS_PRICE_GWEI;
    private readonly GAS_PRICE_BUMP_PERCENT;
    private readonly CONFIRM_RETRY_DELAY_MS;
    private rpcUrl;
    private chainId;
    private nonceLocks;
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
     * A) JOB PICKING (NO queue locks)
     * - Fetch 25 candidates, sort in code by priority, pick first
     * - NO row-level locking here - locking happens at wallet_balances level
     */
    private pickNextJob;
    /**
     * Process job with wallet-level gas locking
     * CRITICAL: Gas lock must be acquired at wallet_balances level, not job level
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
     * Acquire Postgres advisory lock for EVM funder (nonce serialization)
     * BSC-SPECIFIC: Per-funder serialization using Postgres advisory locks
     */
    private acquireEvmFunderLock;
    /**
     * Release Postgres advisory lock for EVM funder
     */
    private releaseEvmFunderLock;
    /**
     * Process a single gas top-up job through state machine
     * F) IDEMPOTENCY (CRITICAL): If tx_hash exists => NEVER build/sign/broadcast again, only confirm
     * G) RETRY: MAX_RETRIES=8, exponential backoff
     */
    private processJob;
    /**
     * Execute a new gas top-up job
     * BSC-SPECIFIC: Per-funder serialization using Postgres advisory locks
     */
    private executeNewJob;
    /**
     * Execute job with nonce lock held
     */
    private executeWithNonceLock;
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
     */
    private validateFundingBalance;
    /**
     * Get current gas price with capping
     * FIX 5c: Gas spike protection
     */
    private getGasPrice;
    /**
     * Build unsigned EVM transaction
     * FIX 5b: Nonce management and gas price handling
     */
    private buildUnsignedTransaction;
    /**
     * Sign transaction via signer service
     * STEP 3: Convert unsigned EVM tx to hex before sending to signer
     */
    private signTransaction;
    /**
     * Broadcast signed transaction with replacement handling
     * FIX 5b: Replacement strategy hardening
     */
    private broadcastTransactionWithReplacement;
    /**
     * FIX 6: ERROR CLASSIFICATION - Minimal classification for BSC
     */
    private classifyBscError;
    /**
     * Confirm transaction
     * FIX 6: Confirmation loop safety
     */
    private confirmTransaction;
    /**
     * Write audit record
     */
    private writeAuditRecord;
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
//# sourceMappingURL=bsc-gas-topup.worker.d.ts.map
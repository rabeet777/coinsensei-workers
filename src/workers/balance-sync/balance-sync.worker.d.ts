export declare class BalanceSyncWorker {
    private supabase;
    private runtime;
    private chainClients;
    private isRunning;
    private stopHeartbeat;
    private readonly BATCH_SIZE;
    private readonly LOCK_DURATION_SECONDS;
    private readonly SYNC_INTERVAL_MS;
    constructor();
    get WORKER_ID(): string;
    /**
     * Initialize worker: load chains and create clients
     */
    initialize(): Promise<void>;
    /**
     * Initialize blockchain clients for active chains
     */
    private initializeChainClients;
    /**
     * Process a batch of wallet balances
     */
    processBatch(): Promise<void>;
    /**
     * Select and lock rows for processing
     * CRITICAL: Selects ALL wallet_balances rows (both user and operation wallets)
     * No filtering by wallet type - balance sync must handle both
     */
    private selectAndLockRows;
    /**
     * Process a single wallet balance row
     */
    private processWalletBalance;
    /**
     * Fetch on-chain balance for an asset (DATA-DRIVEN)
     * Handles both native assets (TRX, BNB) and token assets (USDT, etc.)
     * based on asset_on_chain.is_native flag
     */
    private fetchOnChainBalance;
    /**
     * Update wallet_balances with new on-chain balance
     * ONLY updates balance-related fields, does NOT touch lock/status fields
     */
    private updateBalance;
    /**
     * Release lock after processing (success or failure)
     */
    private releaseLock;
    /**
     * Record error and release lock
     */
    private recordError;
    /**
     * Start the worker loop
     */
    start(): Promise<void>;
    /**
     * Stop the worker loop
     */
    stop(): void;
    /**
     * Release all locks held by this worker (cleanup)
     */
    releaseAllLocks(): Promise<void>;
}
//# sourceMappingURL=balance-sync.worker.d.ts.map
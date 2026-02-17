export declare class BscConsolidationWorker {
    private supabase;
    private signerService;
    private runtime;
    private isRunning;
    private stopHeartbeat;
    private readonly POLL_INTERVAL_MS;
    private readonly MAX_RETRIES;
    private readonly LOCK_DURATION_MINUTES;
    private chainId;
    constructor();
    get WORKER_ID(): string;
    initialize(): Promise<void>;
    /**
     * Main processing loop
     */
    processBatch(): Promise<void>;
    /**
     * Pick next pending job for BSC chain
     */
    private pickNextJob;
    /**
     * Process a single consolidation job
     */
    private processJob;
    /**
     * Validate wallet state before processing
     */
    private validateWalletState;
    /**
     * Acquire consolidation lock on wallet_balances
     */
    private acquireConsolidationLock;
    /**
     * Execute consolidation transaction
     */
    private executeConsolidation;
    /**
     * Load source wallet address (user wallet)
     */
    private loadSourceWallet;
    /**
     * Load destination wallet address (hot wallet)
     */
    private loadDestinationWallet;
    /**
     * Load asset information
     */
    private loadAssetInfo;
    /**
     * Update job status
     */
    private updateJobStatus;
    /**
     * Get current retry count
     */
    private getRetryCount;
    /**
     * Update job with transaction hash and move to confirming
     */
    private updateJobTxHash;
    /**
     * Mark job as failed (non-retryable)
     */
    private markJobFailed;
    /**
     * Release consolidation lock on error
     */
    private releaseConsolidationLock;
    /**
     * Handle job error with retry logic
     */
    private handleJobError;
    /**
     * Start the worker loop
     */
    start(): Promise<void>;
    /**
     * Stop the worker loop
     */
    stop(): void;
}
//# sourceMappingURL=bsc-consolidation.worker.d.ts.map
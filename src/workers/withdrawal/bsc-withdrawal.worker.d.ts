export declare class BscWithdrawalWorker {
    private supabase;
    private signerService;
    private runtime;
    private isRunning;
    private stopHeartbeat;
    private readonly POLL_INTERVAL_MS;
    private readonly MAX_RETRIES;
    private chainId;
    private chainConfig;
    constructor();
    get WORKER_ID(): string;
    /**
     * Initialize worker - load BSC chain configuration
     */
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
     * Process a single withdrawal job
     */
    private processJob;
    /**
     * Load hot wallet (operation wallet)
     */
    private loadHotWallet;
    /**
     * Load asset configuration
     */
    private loadAsset;
    /**
     * Lock hot wallet balance during withdrawal processing
     */
    private lockHotWalletBalance;
    /**
     * Release hot wallet balance lock
     */
    private releaseBalanceLock;
    /**
     * Build transaction intent (native BNB or BEP20 token)
     */
    private buildTransactionIntent;
    /**
     * Update job status
     */
    private updateJobStatus;
    /**
     * Handle job error
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
//# sourceMappingURL=bsc-withdrawal.worker.d.ts.map
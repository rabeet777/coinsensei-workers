export declare class WithdrawalConfirmationWorker {
    private supabase;
    private runtime;
    private isRunning;
    private stopHeartbeat;
    private readonly BATCH_SIZE;
    private chains;
    private tronClients;
    private evmClients;
    private defaultPollInterval;
    constructor();
    /**
     * Initialize worker - load chain configurations and create RPC clients
     */
    initialize(): Promise<void>;
    /**
     * Process a batch of confirming jobs
     */
    processBatch(): Promise<void>;
    /**
     * Pick jobs with status='confirming' and tx_hash IS NOT NULL
     */
    private pickConfirmingJobs;
    /**
     * Process a single job for confirmation
     */
    private processJob;
    /**
     * Confirm TRON transaction
     */
    private confirmTronTransaction;
    /**
     * Confirm EVM transaction (BSC, etc.)
     */
    private confirmEvmTransaction;
    /**
     * Finalize successful withdrawal (ATOMIC)
     */
    private finalizeSuccess;
    /**
     * Finalize failed withdrawal (ATOMIC)
     */
    private finalizeFailure;
    /**
     * Release hot wallet balance lock
     */
    private releaseHotWalletLock;
    /**
     * Start the worker loop
     */
    start(): Promise<void>;
    /**
     * Stop the worker loop
     */
    stop(): void;
}
//# sourceMappingURL=withdrawal-confirmation.worker.d.ts.map
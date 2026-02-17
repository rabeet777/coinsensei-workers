export declare class GasConfirmationWorker {
    private supabase;
    private runtime;
    private isRunning;
    private stopHeartbeat;
    private readonly POLL_INTERVAL_MS;
    private readonly BATCH_SIZE;
    private chains;
    private tronClients;
    private bscClients;
    constructor();
    /**
     * Initialize worker - load chain configurations
     */
    initialize(): Promise<void>;
    /**
     * Process a batch of confirming jobs
     */
    processBatch(): Promise<void>;
    /**
     * Pick jobs that need confirmation
     * Select jobs where status='confirming' and tx_hash IS NOT NULL
     */
    private pickConfirmingJobs;
    /**
     * Confirm a single job by checking on-chain status
     */
    private confirmJob;
    /**
     * Confirm TRON transaction
     */
    private confirmTronTransaction;
    /**
     * Confirm BSC transaction
     */
    private confirmBscTransaction;
    /**
     * Finalize successful transaction (ATOMIC)
     */
    private finalizeSuccess;
    /**
     * Finalize failed transaction (ATOMIC)
     */
    private finalizeFailure;
    /**
     * Release gas lock at wallet_balances level
     */
    private releaseGasLock;
    /**
     * Start worker loop
     */
    start(): Promise<void>;
    /**
     * Stop worker
     */
    stop(): void;
}
//# sourceMappingURL=gas-confirmation.worker.d.ts.map
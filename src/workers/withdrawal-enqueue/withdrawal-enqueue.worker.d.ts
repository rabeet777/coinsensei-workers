export declare class WithdrawalEnqueueWorker {
    private supabase;
    private runtime;
    private isRunning;
    private stopHeartbeat;
    private readonly POLL_INTERVAL_MS;
    private readonly BATCH_SIZE;
    constructor();
    /**
     * Initialize worker
     */
    initialize(): Promise<void>;
    /**
     * Process a batch of approved withdrawal requests
     */
    processBatch(): Promise<void>;
    /**
     * Pick approved withdrawal requests that haven't been queued yet
     */
    private pickApprovedRequests;
    /**
     * Process a single withdrawal request
     */
    private processRequest;
    /**
     * Load chain configuration
     */
    private loadChainConfig;
    /**
     * Load asset on chain by asset_id and chain_id
     */
    private loadAssetOnChain;
    /**
     * Load asset on chain by asset_on_chain_id directly
     */
    private loadAssetOnChainById;
    /**
     * Select hot wallet using round-robin strategy (last_used_at ASC)
     */
    private selectHotWallet;
    /**
     * Calculate raw amount (smallest unit) from human amount
     */
    private calculateRawAmount;
    /**
     * Start the worker loop
     */
    start(): Promise<void>;
    /**
     * Stop the worker loop
     */
    stop(): void;
}
//# sourceMappingURL=withdrawal-enqueue.worker.d.ts.map
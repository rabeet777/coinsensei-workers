export declare class TronDepositWorker {
    private supabase;
    private runtime;
    private tronClient;
    private chainConfig;
    private activeAssets;
    private userAddressMap;
    private isRunning;
    private stopHeartbeat;
    constructor();
    /**
     * Initialize worker: load chain config, assets, and user addresses
     */
    initialize(): Promise<void>;
    /**
     * Load TRON chain configuration from database
     */
    private loadChainConfig;
    /**
     * Load active TRC20 assets from database
     */
    private loadActiveAssets;
    /**
     * Load user wallet addresses for TRON chain
     */
    private loadUserAddresses;
    /**
     * Initialize worker state in database if not exists
     */
    private initializeWorkerState;
    /**
     * Get current worker state
     */
    private getWorkerState;
    /**
     * Update worker state with new last processed block
     */
    private updateWorkerState;
    /**
     * Scan TRON deposits for all active assets
     */
    scanDeposits(): Promise<void>;
    /**
     * Process deposits for a specific asset
     */
    private processAssetDeposits;
    /**
     * Process a single deposit: insert to DB and credit user balance
     */
    private processDeposit;
    /**
     * REMOVED: Balance crediting is now handled by separate confirmation worker
     * This deposit listener only detects and records deposits as PENDING
     */
    /**
     * Start the worker loop
     */
    start(): Promise<void>;
    /**
     * Stop the worker loop
     */
    stop(): void;
    /**
     * Reload configuration and user addresses
     */
    reload(): Promise<void>;
}
//# sourceMappingURL=tron.deposit.worker.d.ts.map
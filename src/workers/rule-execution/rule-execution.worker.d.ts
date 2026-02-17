export declare class RuleExecutionWorker {
    private supabase;
    private runtime;
    private isRunning;
    private stopHeartbeat;
    private readonly BATCH_SIZE;
    private readonly LOCK_DURATION_SECONDS;
    private readonly EXECUTION_INTERVAL_MS;
    constructor();
    get WORKER_ID(): string;
    /**
     * Initialize worker
     */
    initialize(): Promise<void>;
    /**
     * Process a batch of wallet balances
     */
    processBatch(): Promise<void>;
    /**
     * Select and lock rows for processing
     * CRITICAL: Only selects wallets from user_wallet_addresses (operation wallets excluded)
     */
    private selectAndLockRows;
    /**
     * Process a single wallet balance row
     */
    private processWalletBalance;
    /**
     * Execute consolidation rules for a wallet balance
     */
    private executeConsolidationRules;
    /**
     * Execute gas top-up rules for a wallet balance
     */
    private executeGasTopupRules;
    /**
     * Evaluate a rule condition (comparison)
     * CRITICAL: Must handle balance = 0 correctly (0 is a valid balance, not "no balance")
     */
    private evaluateCondition;
    /**
     * Log consolidation rule execution
     */
    private logConsolidationRuleExecution;
    /**
     * Log gas top-up rule execution
     */
    private logGasTopupRuleExecution;
    /**
     * Enqueue consolidation operation
     */
    private enqueueConsolidation;
    /**
     * Enqueue gas top-up operation
     */
    private enqueueGasTopup;
    /**
     * Select hot wallet address for consolidation (chain-matched, round-robin)
     */
    private selectHotWalletAddress;
    /**
     * Select gas operation wallet address (chain-matched with fallback)
     */
    private selectGasWalletAddress;
    /**
     * Update operation wallet address last_used_at for round-robin (best effort)
     */
    private updateWalletAddressUsage;
    /**
     * Update native gas flags (only on native asset row, not all rows for wallet)
     * CRITICAL: Only updates user wallets (verified before update)
     */
    private updateNativeGasFlags;
    /**
     * Finalize wallet balance after rule execution
     * CRITICAL: Only updates user wallets (safety check included)
     */
    private finalizeWalletBalance;
    /**
     * Record error and release lock
     * CRITICAL: Only updates user wallets (safety check included)
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
//# sourceMappingURL=rule-execution.worker.d.ts.map
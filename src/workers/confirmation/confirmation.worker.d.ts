export declare class ConfirmationWorker {
    private supabase;
    private runtime;
    private chains;
    private clients;
    private isRunning;
    private stopHeartbeat;
    private readonly BATCH_SIZE;
    constructor();
    /**
     * Initialize worker: load chains with pending deposits
     */
    initialize(): Promise<void>;
    /**
     * Load active chains from database
     */
    private loadActiveChains;
    /**
     * Initialize blockchain clients for each chain
     */
    private initializeChainClients;
    /**
     * Process pending deposits for all chains
     */
    processPendingDeposits(): Promise<void>;
    /**
     * Process pending deposits for a specific chain
     */
    private processChainDeposits;
    /**
     * Process a single pending deposit
     */
    private processDeposit;
    /**
     * Update confirmation count for a deposit (not ready to confirm yet)
     */
    private updateConfirmationCount;
    /**
     * Confirm deposit and credit user balance (ATOMIC OPERATION)
     */
    private confirmAndCreditDeposit;
    /**
     * Credit balance for an already-confirmed deposit (retry scenario)
     */
    private creditDepositBalance;
    /**
     * Start the worker loop
     */
    start(): Promise<void>;
    /**
     * Stop the worker loop
     */
    stop(): void;
}
//# sourceMappingURL=confirmation.worker.d.ts.map
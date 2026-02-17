export declare class BscConfirmationClient {
    private provider;
    private rpcUrl;
    private readonly MAX_RETRIES;
    constructor(rpcUrl: string);
    /**
     * Get current block number
     */
    getCurrentBlockNumber(): Promise<number>;
    /**
     * Retry logic with exponential backoff
     */
    private retryWithBackoff;
}
//# sourceMappingURL=bsc.confirmation.client.d.ts.map
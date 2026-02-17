export declare class TronConfirmationClient {
    private tronWeb;
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
//# sourceMappingURL=tron.confirmation.client.d.ts.map
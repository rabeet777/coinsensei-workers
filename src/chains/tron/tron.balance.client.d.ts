export declare class TronBalanceClient {
    private tronWeb;
    private rpcUrl;
    private readonly MAX_RETRIES;
    constructor(rpcUrl: string);
    /**
     * Get native TRX balance for an address
     */
    getNativeBalance(address: string): Promise<string>;
    /**
     * Get TRC20 token balance for an address
     */
    getTokenBalance(contractAddress: string, walletAddress: string): Promise<string>;
    /**
     * Calculate human-readable amount from raw amount
     */
    calculateHumanAmount(amountRaw: string, decimals: number): string;
    /**
     * Retry logic with exponential backoff
     */
    private retryWithBackoff;
}
//# sourceMappingURL=tron.balance.client.d.ts.map
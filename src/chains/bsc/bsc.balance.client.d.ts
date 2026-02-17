export declare class BscBalanceClient {
    private provider;
    private rpcUrl;
    private readonly MAX_RETRIES;
    private readonly ERC20_ABI;
    constructor(rpcUrl: string);
    /**
     * Get native balance (BNB, ETH, etc.) for an address
     */
    getNativeBalance(address: string): Promise<string>;
    /**
     * Get ERC20/BEP20 token balance for an address
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
//# sourceMappingURL=bsc.balance.client.d.ts.map
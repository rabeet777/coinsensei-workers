export interface TronChainConfig {
    chainId: string;
    name: string;
    rpcUrl: string;
    confirmationThreshold: number;
}
export interface TRC20Transfer {
    transactionHash: string;
    logIndex: number;
    from: string;
    to: string;
    value: string;
    blockNumber: number;
    blockTimestamp: number;
    contractAddress: string;
}
export declare class TronClient {
    private tronWeb;
    private config;
    private readonly MAX_RETRIES;
    constructor(config: TronChainConfig);
    /**
     * Get current block number
     */
    getCurrentBlockNumber(): Promise<number>;
    /**
     * Get block by number
     */
    getBlockByNumber(blockNumber: number): Promise<any>;
    /**
     * Fetch TRC20 Transfer events for a contract in a block range
     */
    getTRC20Transfers(contractAddress: string, fromBlock: number, toBlock: number): Promise<TRC20Transfer[]>;
    /**
     * Alternative method using TronGrid API
     */
    private getTRC20TransfersViaTronGrid;
    /**
     * Convert hex address to base58
     */
    hexToBase58(hexAddress: string): string;
    /**
     * Convert base58 address to hex
     */
    base58ToHex(base58Address: string): string;
    /**
     * Retry logic with exponential backoff
     */
    private retryWithBackoff;
    getChainId(): string;
    getConfirmationThreshold(): number;
}
//# sourceMappingURL=tron.client.d.ts.map
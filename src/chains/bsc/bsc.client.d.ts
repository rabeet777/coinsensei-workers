import { ethers } from 'ethers';
export interface BscChainConfig {
    chainId: string;
    name: string;
    rpcUrl: string;
    confirmationThreshold: number;
}
export interface ERC20Transfer {
    transactionHash: string;
    logIndex: number;
    from: string;
    to: string;
    value: string;
    blockNumber: number;
    blockTimestamp: number;
    contractAddress: string;
}
export declare class BscClient {
    private provider;
    private config;
    private readonly MAX_RETRIES;
    private readonly ERC20_TRANSFER_TOPIC;
    constructor(config: BscChainConfig);
    /**
     * Get current block number
     */
    getCurrentBlockNumber(): Promise<number>;
    /**
     * Get block by number with timestamp
     */
    getBlock(blockNumber: number): Promise<ethers.Block | null>;
    /**
     * Fetch ERC20 Transfer events for a contract in a block range
     */
    getERC20Transfers(contractAddress: string, fromBlock: number, toBlock: number): Promise<ERC20Transfer[]>;
    /**
     * Validate Ethereum address
     */
    isValidAddress(address: string): boolean;
    /**
     * Retry logic with exponential backoff
     */
    private retryWithBackoff;
    getChainId(): string;
    getConfirmationThreshold(): number;
}
//# sourceMappingURL=bsc.client.d.ts.map
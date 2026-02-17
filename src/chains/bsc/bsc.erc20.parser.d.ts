import type { ERC20Transfer } from './bsc.client.js';
export interface ParsedDeposit {
    txHash: string;
    logIndex: number;
    from: string;
    to: string;
    amountRaw: string;
    blockNumber: number;
    blockTimestamp: Date;
    contractAddress: string;
    assetOnChainId: string;
}
export declare class BscERC20Parser {
    /**
     * Parse ERC20 Transfer event into deposit format
     */
    static parseTransfer(transfer: ERC20Transfer, assetOnChainId: string): ParsedDeposit;
    /**
     * Calculate human-readable amount from raw amount
     */
    static calculateHumanAmount(amountRaw: string, decimals: number): string;
    /**
     * Validate Ethereum address format
     */
    static isValidEthereumAddress(address: string): boolean;
    /**
     * Validate transfer has minimum required fields
     */
    static isValidTransfer(transfer: ERC20Transfer): boolean;
}
//# sourceMappingURL=bsc.erc20.parser.d.ts.map
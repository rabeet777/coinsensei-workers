import type { TRC20Transfer } from './tron.client.js';
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
export declare class TronTRC20TransferParser {
    /**
     * Parse TRC20 Transfer event into deposit format
     */
    static parseTransfer(transfer: TRC20Transfer, assetOnChainId: string): ParsedDeposit;
    /**
     * Calculate human-readable amount from raw amount
     */
    static calculateHumanAmount(amountRaw: string, decimals: number): string;
    /**
     * Validate TRON address format
     */
    static isValidTronAddress(address: string): boolean;
    /**
     * Validate transfer has minimum required fields
     */
    static isValidTransfer(transfer: TRC20Transfer): boolean;
}
//# sourceMappingURL=tron.usdt.parser.d.ts.map
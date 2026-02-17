export class TronTRC20TransferParser {
    /**
     * Parse TRC20 Transfer event into deposit format
     */
    static parseTransfer(transfer, assetOnChainId) {
        return {
            txHash: transfer.transactionHash,
            logIndex: transfer.logIndex,
            from: transfer.from,
            to: transfer.to,
            amountRaw: transfer.value,
            blockNumber: transfer.blockNumber,
            blockTimestamp: new Date(transfer.blockTimestamp),
            contractAddress: transfer.contractAddress,
            assetOnChainId,
        };
    }
    /**
     * Calculate human-readable amount from raw amount
     */
    static calculateHumanAmount(amountRaw, decimals) {
        const rawBigInt = BigInt(amountRaw);
        const divisor = BigInt(10) ** BigInt(decimals);
        // Calculate integer and fractional parts
        const integerPart = rawBigInt / divisor;
        const fractionalPart = rawBigInt % divisor;
        // Format with decimals
        if (fractionalPart === 0n) {
            return integerPart.toString();
        }
        const fractionalStr = fractionalPart
            .toString()
            .padStart(decimals, '0')
            .replace(/0+$/, ''); // Remove trailing zeros
        return `${integerPart}.${fractionalStr}`;
    }
    /**
     * Validate TRON address format
     */
    static isValidTronAddress(address) {
        // TRON addresses start with 'T' and are 34 characters long
        return /^T[A-Za-z0-9]{33}$/.test(address);
    }
    /**
     * Validate transfer has minimum required fields
     */
    static isValidTransfer(transfer) {
        return (!!transfer.transactionHash &&
            !!transfer.to &&
            !!transfer.from &&
            !!transfer.value &&
            transfer.blockNumber > 0 &&
            this.isValidTronAddress(transfer.to) &&
            this.isValidTronAddress(transfer.from));
    }
}
//# sourceMappingURL=tron.usdt.parser.js.map
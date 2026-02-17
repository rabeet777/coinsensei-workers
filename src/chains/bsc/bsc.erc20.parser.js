export class BscERC20Parser {
    /**
     * Parse ERC20 Transfer event into deposit format
     */
    static parseTransfer(transfer, assetOnChainId) {
        return {
            txHash: transfer.transactionHash,
            logIndex: transfer.logIndex,
            from: transfer.from,
            to: transfer.to,
            amountRaw: transfer.value,
            blockNumber: transfer.blockNumber,
            blockTimestamp: new Date(transfer.blockTimestamp * 1000), // Convert to milliseconds
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
     * Validate Ethereum address format
     */
    static isValidEthereumAddress(address) {
        return /^0x[a-fA-F0-9]{40}$/.test(address);
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
            this.isValidEthereumAddress(transfer.to) &&
            this.isValidEthereumAddress(transfer.from) &&
            transfer.value !== '0' // Ignore zero-value transfers
        );
    }
}
//# sourceMappingURL=bsc.erc20.parser.js.map
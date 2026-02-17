import { TronWeb } from 'tronweb';
import { logger } from '../../utils/logger.js';
import { sleepWithBackoff } from '../../utils/sleep.js';
export class TronBalanceClient {
    tronWeb;
    rpcUrl;
    MAX_RETRIES = 3;
    constructor(rpcUrl) {
        this.rpcUrl = rpcUrl;
        this.tronWeb = new TronWeb({
            fullHost: rpcUrl,
        });
    }
    /**
     * Get native TRX balance for an address
     */
    async getNativeBalance(address) {
        return this.retryWithBackoff(async () => {
            const balance = await this.tronWeb.trx.getBalance(address);
            return balance.toString(); // Returns balance in SUN (1 TRX = 1,000,000 SUN)
        }, `getNativeBalance(${address})`);
    }
    /**
     * Get TRC20 token balance for an address
     */
    async getTokenBalance(contractAddress, walletAddress) {
        return this.retryWithBackoff(async () => {
            try {
                // TronWeb alternative method using parameter
                const parameter = [{ type: 'address', value: walletAddress }];
                const options = {
                    functionSelector: 'balanceOf(address)',
                    parameter,
                };
                // Call contract method
                const result = await this.tronWeb.transactionBuilder.triggerConstantContract(this.tronWeb.address.toHex(contractAddress), options.functionSelector, {}, parameter, this.tronWeb.address.toHex(walletAddress));
                if (!result || !result.constant_result || result.constant_result.length === 0) {
                    // Return 0 if no result (wallet doesn't have this token)
                    return '0';
                }
                // Decode the result
                const balance = BigInt('0x' + result.constant_result[0]).toString();
                return balance;
            }
            catch (error) {
                logger.error({
                    error: error.message,
                    contractAddress,
                    walletAddress,
                }, 'Failed to fetch TRC20 balance');
                throw error;
            }
        }, `getTokenBalance(${contractAddress}, ${walletAddress})`);
    }
    /**
     * Calculate human-readable amount from raw amount
     */
    calculateHumanAmount(amountRaw, decimals) {
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
     * Retry logic with exponential backoff
     */
    async retryWithBackoff(fn, operation) {
        let lastError = null;
        for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
            try {
                return await fn();
            }
            catch (error) {
                lastError = error;
                logger.warn({
                    attempt: attempt + 1,
                    error: error.message,
                    operation,
                    chain: 'tron',
                }, 'RPC call failed, retrying...');
                if (attempt < this.MAX_RETRIES - 1) {
                    await sleepWithBackoff(attempt);
                }
            }
        }
        logger.error({ error: lastError?.message, operation, chain: 'tron' }, 'RPC call failed after all retries');
        throw lastError;
    }
}
//# sourceMappingURL=tron.balance.client.js.map
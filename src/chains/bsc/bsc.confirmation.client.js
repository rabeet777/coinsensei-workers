import { ethers } from 'ethers';
import { logger } from '../../utils/logger.js';
import { sleepWithBackoff } from '../../utils/sleep.js';
export class BscConfirmationClient {
    provider;
    rpcUrl;
    MAX_RETRIES = 3;
    constructor(rpcUrl) {
        this.rpcUrl = rpcUrl;
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
    }
    /**
     * Get current block number
     */
    async getCurrentBlockNumber() {
        return this.retryWithBackoff(async () => {
            return await this.provider.getBlockNumber();
        }, 'getCurrentBlockNumber');
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
                logger.warn({ attempt: attempt + 1, error: error.message, operation, chain: 'bsc' }, 'RPC call failed, retrying...');
                if (attempt < this.MAX_RETRIES - 1) {
                    await sleepWithBackoff(attempt);
                }
            }
        }
        logger.error({ error: lastError?.message, operation, chain: 'bsc' }, 'RPC call failed after all retries');
        throw lastError;
    }
}
//# sourceMappingURL=bsc.confirmation.client.js.map
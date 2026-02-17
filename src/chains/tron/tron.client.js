import { TronWeb } from 'tronweb';
import { logger } from '../../utils/logger.js';
import { sleepWithBackoff } from '../../utils/sleep.js';
export class TronClient {
    tronWeb;
    config;
    MAX_RETRIES = 3;
    constructor(config) {
        this.config = config;
        this.tronWeb = new TronWeb({
            fullHost: config.rpcUrl,
        });
    }
    /**
     * Get current block number
     */
    async getCurrentBlockNumber() {
        return this.retryWithBackoff(async () => {
            const block = await this.tronWeb.trx.getCurrentBlock();
            return block.block_header.raw_data.number;
        }, 'getCurrentBlockNumber');
    }
    /**
     * Get block by number
     */
    async getBlockByNumber(blockNumber) {
        return this.retryWithBackoff(async () => {
            return await this.tronWeb.trx.getBlock(blockNumber);
        }, `getBlockByNumber(${blockNumber})`);
    }
    /**
     * Fetch TRC20 Transfer events for a contract in a block range
     */
    async getTRC20Transfers(contractAddress, fromBlock, toBlock) {
        return this.retryWithBackoff(async () => {
            const transfers = [];
            try {
                // Get contract instance
                const contract = await this.tronWeb.contract().at(contractAddress);
                // Fetch Transfer events
                // TronWeb doesn't have a great event filtering API, so we need to scan blocks
                // For production, consider using TronGrid API directly
                const events = await contract.getPastEvents('Transfer', {
                    fromBlock,
                    toBlock,
                });
                for (const event of events) {
                    const { result, transaction, block, resourceNode } = event;
                    if (!result || !transaction) {
                        continue;
                    }
                    const transfer = {
                        transactionHash: transaction,
                        logIndex: event.event_index || 0,
                        from: this.tronWeb.address.fromHex(result.from || result._from),
                        to: this.tronWeb.address.fromHex(result.to || result._to),
                        value: (result.value || result._value || '0').toString(),
                        blockNumber: block || fromBlock,
                        blockTimestamp: event.timestamp || Date.now(),
                        contractAddress,
                    };
                    transfers.push(transfer);
                }
                return transfers;
            }
            catch (error) {
                // If the method doesn't exist or fails, try TronGrid API
                logger.warn({ error: error.message, contractAddress, fromBlock, toBlock }, 'Contract event fetching failed, trying TronGrid API');
                return await this.getTRC20TransfersViaTronGrid(contractAddress, fromBlock, toBlock);
            }
        }, `getTRC20Transfers(${contractAddress}, ${fromBlock}-${toBlock})`);
    }
    /**
     * Alternative method using TronGrid API
     */
    async getTRC20TransfersViaTronGrid(contractAddress, fromBlock, toBlock) {
        const transfers = [];
        try {
            // Use TronGrid event API
            const url = `${this.config.rpcUrl}/v1/contracts/${contractAddress}/events`;
            const params = new URLSearchParams({
                event_name: 'Transfer',
                min_block_timestamp: (fromBlock * 3000).toString(), // Approximate
                limit: '200',
            });
            logger.debug({ url: `${url}?${params}`, fromBlock, toBlock }, 'Fetching events from TronGrid API');
            const response = await fetch(`${url}?${params}`);
            if (!response.ok) {
                throw new Error(`TronGrid API error: ${response.statusText}`);
            }
            const data = await response.json();
            logger.debug({
                totalEvents: data.data?.length || 0,
                fromBlock,
                toBlock,
                contractAddress
            }, 'TronGrid API response');
            if (data.data && Array.isArray(data.data)) {
                for (const event of data.data) {
                    // Filter by block range
                    if (event.block_number < fromBlock ||
                        event.block_number > toBlock) {
                        continue;
                    }
                    const transfer = {
                        transactionHash: event.transaction_id,
                        logIndex: event.event_index || 0,
                        from: this.tronWeb.address.fromHex(event.result.from),
                        to: this.tronWeb.address.fromHex(event.result.to),
                        value: event.result.value || '0',
                        blockNumber: event.block_number,
                        blockTimestamp: event.block_timestamp,
                        contractAddress,
                    };
                    transfers.push(transfer);
                }
                if (transfers.length > 0) {
                    logger.info({
                        transfersFound: transfers.length,
                        fromBlock,
                        toBlock,
                        contractAddress,
                        sampleTransfer: transfers[0]
                    }, 'Found TRC20 transfers in block range');
                }
            }
        }
        catch (error) {
            logger.error({ error: error.message, contractAddress, fromBlock, toBlock }, 'Failed to fetch events from TronGrid');
            // Return empty array rather than throwing
            return [];
        }
        return transfers;
    }
    /**
     * Convert hex address to base58
     */
    hexToBase58(hexAddress) {
        return this.tronWeb.address.fromHex(hexAddress);
    }
    /**
     * Convert base58 address to hex
     */
    base58ToHex(base58Address) {
        return this.tronWeb.address.toHex(base58Address);
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
                logger.warn({ attempt: attempt + 1, error: error.message, operation }, 'RPC call failed, retrying...');
                if (attempt < this.MAX_RETRIES - 1) {
                    await sleepWithBackoff(attempt);
                }
            }
        }
        logger.error({ error: lastError?.message, operation }, 'RPC call failed after all retries');
        throw lastError;
    }
    getChainId() {
        return this.config.chainId;
    }
    getConfirmationThreshold() {
        return this.config.confirmationThreshold;
    }
}
//# sourceMappingURL=tron.client.js.map
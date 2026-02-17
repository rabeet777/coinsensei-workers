import { ethers } from 'ethers';
import { logger } from '../../utils/logger.js';
import { sleepWithBackoff } from '../../utils/sleep.js';

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

export class BscClient {
  private provider: ethers.JsonRpcProvider;
  private config: BscChainConfig;
  private readonly MAX_RETRIES = 3;
  private readonly ERC20_TRANSFER_TOPIC =
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // keccak256("Transfer(address,address,uint256)")

  constructor(config: BscChainConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
  }

  /**
   * Get current block number
   */
  async getCurrentBlockNumber(): Promise<number> {
    return this.retryWithBackoff(async () => {
      return await this.provider.getBlockNumber();
    }, 'getCurrentBlockNumber');
  }

  /**
   * Get block by number with timestamp
   */
  async getBlock(blockNumber: number): Promise<ethers.Block | null> {
    return this.retryWithBackoff(async () => {
      return await this.provider.getBlock(blockNumber);
    }, `getBlock(${blockNumber})`);
  }

  /**
   * Fetch ERC20 Transfer events for a contract in a block range
   */
  async getERC20Transfers(
    contractAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<ERC20Transfer[]> {
    return this.retryWithBackoff(async () => {
      const transfers: ERC20Transfer[] = [];

      try {
        // Create filter for Transfer events
        const filter = {
          address: contractAddress,
          fromBlock,
          toBlock,
          topics: [this.ERC20_TRANSFER_TOPIC],
        };

        logger.debug(
          { contractAddress, fromBlock, toBlock },
          'Fetching ERC20 Transfer events'
        );

        // Fetch logs
        const logs = await this.provider.getLogs(filter);

        logger.debug(
          {
            contractAddress,
            fromBlock,
            toBlock,
            logsFound: logs.length,
          },
          'ERC20 logs fetched'
        );

        // Parse each log
        for (const log of logs) {
          try {
            // ERC20 Transfer has 3 topics: event signature, from, to
            if (log.topics.length < 3) {
              logger.warn(
                { log, contractAddress },
                'Invalid Transfer log - insufficient topics'
              );
              continue;
            }

            const from = ethers.getAddress(
              ethers.dataSlice(log.topics[1]!, 12)
            );
            const to = ethers.getAddress(ethers.dataSlice(log.topics[2]!, 12));
            const value = ethers.getBigInt(log.data).toString();

            // Get block timestamp
            const block = await this.getBlock(log.blockNumber);
            if (!block) {
              logger.warn(
                { blockNumber: log.blockNumber },
                'Could not fetch block for timestamp'
              );
              continue;
            }

            const transfer: ERC20Transfer = {
              transactionHash: log.transactionHash,
              logIndex: log.index,
              from,
              to,
              value,
              blockNumber: log.blockNumber,
              blockTimestamp: block.timestamp,
              contractAddress,
            };

            transfers.push(transfer);
          } catch (parseError: any) {
            logger.error(
              {
                error: parseError.message,
                log,
                contractAddress,
              },
              'Error parsing Transfer log'
            );
            continue;
          }
        }

        if (transfers.length > 0) {
          logger.info(
            {
              transfersFound: transfers.length,
              fromBlock,
              toBlock,
              contractAddress,
              sampleTransfer: transfers[0],
            },
            'Found ERC20 transfers in block range'
          );
        }

        return transfers;
      } catch (error: any) {
        logger.error(
          { error: error.message, contractAddress, fromBlock, toBlock },
          'Failed to fetch ERC20 transfers'
        );
        throw error;
      }
    }, `getERC20Transfers(${contractAddress}, ${fromBlock}-${toBlock})`);
  }

  /**
   * Validate Ethereum address
   */
  isValidAddress(address: string): boolean {
    try {
      ethers.getAddress(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retry logic with exponential backoff
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    operation: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        logger.warn(
          { attempt: attempt + 1, error: error.message, operation },
          'RPC call failed, retrying...'
        );

        if (attempt < this.MAX_RETRIES - 1) {
          await sleepWithBackoff(attempt);
        }
      }
    }

    logger.error(
      { error: lastError?.message, operation },
      'RPC call failed after all retries'
    );
    throw lastError;
  }

  getChainId(): string {
    return this.config.chainId;
  }

  getConfirmationThreshold(): number {
    return this.config.confirmationThreshold;
  }
}


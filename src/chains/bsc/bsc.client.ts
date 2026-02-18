import { ethers } from 'ethers';
import { logger } from '../../utils/logger.js';
import { sleep, sleepWithBackoff } from '../../utils/sleep.js';

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

/** Normalize RPC URL: trim and remove trailing slash to avoid SSL/connection issues with some providers (e.g. QuickNode). */
function normalizeRpcUrl(url: string): string {
  const u = url.trim();
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

/** Max blocks per eth_getLogs request; public BSC RPCs rate-limit even small ranges (-32005). */
const ERC20_LOGS_CHUNK_BLOCKS = 5;
/** Delay before first getLogs and between chunks (ms). */
const DELAY_BETWEEN_CHUNKS_MS = 3000;
/** Extra delay before the very first getLogs in a run (ms); public RPC often rate-limits immediately after other calls. */
const INITIAL_DELAY_BEFORE_FIRST_LOGS_MS = 25000;

export class BscClient {
  private provider: ethers.JsonRpcProvider;
  private config: BscChainConfig;
  private readonly MAX_RETRIES = 3;
  private readonly ERC20_TRANSFER_TOPIC =
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // keccak256("Transfer(address,address,uint256)")

  constructor(config: BscChainConfig) {
    this.config = { ...config, rpcUrl: normalizeRpcUrl(config.rpcUrl) };
    this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
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
   * Fetch ERC20 Transfer events for a contract in a block range.
   * Uses chunked eth_getLogs and delay between chunks to avoid public RPC rate limits (-32005).
   */
  async getERC20Transfers(
    contractAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<ERC20Transfer[]> {
    return this.retryWithBackoff(
      async () => {
        const transfers: ERC20Transfer[] = [];

        try {
          // Chunk the range to avoid "method eth_getLogs in batch triggered rate limit" (-32005)
          for (
            let start = fromBlock;
            start <= toBlock;
            start += ERC20_LOGS_CHUNK_BLOCKS
          ) {
            const end = Math.min(
              start + ERC20_LOGS_CHUNK_BLOCKS - 1,
              toBlock
            );
            const filter = {
              address: contractAddress,
              fromBlock: start,
              toBlock: end,
              topics: [this.ERC20_TRANSFER_TOPIC],
            };

            logger.debug(
              { contractAddress, fromBlock: start, toBlock: end },
              'Fetching ERC20 Transfer events (chunk)'
            );

            // Delay before every chunk; use longer initial delay before first getLogs to avoid immediate rate limit
            if (start === fromBlock) {
              await sleep(INITIAL_DELAY_BEFORE_FIRST_LOGS_MS);
            } else {
              await sleep(DELAY_BETWEEN_CHUNKS_MS);
            }

            const logs = await this.provider.getLogs(filter);

          logger.debug(
            {
              contractAddress,
              fromBlock: start,
              toBlock: end,
              logsFound: logs.length,
            },
            'ERC20 logs fetched (chunk)'
          );

          for (const log of logs) {
            try {
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
              const to = ethers.getAddress(
                ethers.dataSlice(log.topics[2]!, 12)
              );
              const value = ethers.getBigInt(log.data).toString();

              const block = await this.getBlock(log.blockNumber);
              if (!block) {
                logger.warn(
                  { blockNumber: log.blockNumber },
                  'Could not fetch block for timestamp'
                );
                continue;
              }

              transfers.push({
                transactionHash: log.transactionHash,
                logIndex: log.index,
                from,
                to,
                value,
                blockNumber: log.blockNumber,
                blockTimestamp: block.timestamp,
                contractAddress,
              });
            } catch (parseError: any) {
              logger.error(
                {
                  error: parseError.message,
                  log,
                  contractAddress,
                },
                'Error parsing Transfer log'
              );
            }
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
   * Retry logic with exponential backoff. Uses longer delay when RPC returns rate limit (-32005).
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    operation: string
  ): Promise<T> {
    let lastError: Error | null = null;
    let lastWasRateLimit = false;

    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        lastWasRateLimit =
          String(error?.message ?? '').includes('-32005') ||
          String(error?.message ?? '').includes('rate limit');
        logger.warn(
          {
            attempt: attempt + 1,
            error: error.message,
            operation,
            isRateLimit: lastWasRateLimit,
          },
          'RPC call failed, retrying...'
        );

        if (attempt < this.MAX_RETRIES - 1) {
          if (lastWasRateLimit) {
            const rateLimitDelayMs = 30000 + attempt * 15000; // 30s, 45s, 60s
            logger.info(
              { rateLimitDelayMs, attempt: attempt + 1 },
              'Rate limit detected, backing off before retry'
            );
            await sleep(rateLimitDelayMs);
          } else {
            await sleepWithBackoff(attempt);
          }
        }
      }
    }

    logger.error(
      { error: lastError?.message, operation },
      'RPC call failed after all retries'
    );

    if (lastWasRateLimit && lastError) {
      throw new Error(
        `BSC RPC rate limit (eth_getLogs -32005) persisted after retries. This endpoint may not support log queries. ` +
          `Update the chain's rpc_url in the database to a provider that allows eth_getLogs (e.g. a paid BSC RPC or another public endpoint that supports logs). ` +
          `Original error: ${lastError.message}`
      );
    }
    throw lastError!;
  }

  getChainId(): string {
    return this.config.chainId;
  }

  getConfirmationThreshold(): number {
    return this.config.confirmationThreshold;
  }
}


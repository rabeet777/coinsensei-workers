import { ethers } from 'ethers';
import { logger } from '../../utils/logger.js';
import { sleepWithBackoff } from '../../utils/sleep.js';

export class BscConfirmationClient {
  private provider: ethers.JsonRpcProvider;
  private rpcUrl: string;
  private readonly MAX_RETRIES = 3;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
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
          { attempt: attempt + 1, error: error.message, operation, chain: 'bsc' },
          'RPC call failed, retrying...'
        );

        if (attempt < this.MAX_RETRIES - 1) {
          await sleepWithBackoff(attempt);
        }
      }
    }

    logger.error(
      { error: lastError?.message, operation, chain: 'bsc' },
      'RPC call failed after all retries'
    );
    throw lastError;
  }
}


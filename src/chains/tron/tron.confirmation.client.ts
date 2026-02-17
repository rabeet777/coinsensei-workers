import { TronWeb } from 'tronweb';
import { logger } from '../../utils/logger.js';
import { sleepWithBackoff } from '../../utils/sleep.js';

export class TronConfirmationClient {
  private tronWeb: any;
  private rpcUrl: string;
  private readonly MAX_RETRIES = 3;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.tronWeb = new TronWeb({
      fullHost: rpcUrl,
    });
  }

  /**
   * Get current block number
   */
  async getCurrentBlockNumber(): Promise<number> {
    return this.retryWithBackoff(async () => {
      const block = await this.tronWeb.trx.getCurrentBlock();
      return block.block_header.raw_data.number;
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
          { attempt: attempt + 1, error: error.message, operation, chain: 'tron' },
          'RPC call failed, retrying...'
        );

        if (attempt < this.MAX_RETRIES - 1) {
          await sleepWithBackoff(attempt);
        }
      }
    }

    logger.error(
      { error: lastError?.message, operation, chain: 'tron' },
      'RPC call failed after all retries'
    );
    throw lastError;
  }
}


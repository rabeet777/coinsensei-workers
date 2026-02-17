import { ethers } from 'ethers';
import { logger } from '../../utils/logger.js';
import { sleepWithBackoff } from '../../utils/sleep.js';

export class BscBalanceClient {
  private provider: ethers.JsonRpcProvider;
  private rpcUrl: string;
  private readonly MAX_RETRIES = 3;

  // Standard ERC20 ABI for balanceOf
  private readonly ERC20_ABI = [
    'function balanceOf(address account) view returns (uint256)',
  ];

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  /**
   * Get native balance (BNB, ETH, etc.) for an address
   */
  async getNativeBalance(address: string): Promise<string> {
    return this.retryWithBackoff(async () => {
      const balance = await this.provider.getBalance(address);
      return balance.toString(); // Returns wei as string
    }, `getNativeBalance(${address})`);
  }

  /**
   * Get ERC20/BEP20 token balance for an address
   */
  async getTokenBalance(
    contractAddress: string,
    walletAddress: string
  ): Promise<string> {
    return this.retryWithBackoff(async () => {
      try {
        // Create contract instance
        const contract = new ethers.Contract(
          contractAddress,
          this.ERC20_ABI,
          this.provider
        );

        // Call balanceOf
        if (!contract.balanceOf) {
          throw new Error('Contract does not have balanceOf method');
        }
        
        const balance = await contract.balanceOf(walletAddress);

        return balance.toString(); // Convert BigInt to string
      } catch (error: any) {
        // Handle empty response (contract doesn't exist or address has no balance)
        if (error.message?.includes('could not decode result data') || 
            error.message?.includes('value=\"0x\"')) {
          logger.debug(
            { contractAddress, walletAddress },
            'Contract returned empty data, treating as zero balance'
          );
          return '0';
        }

        logger.error(
          {
            error: error.message,
            contractAddress,
            walletAddress,
          },
          'Failed to fetch ERC20 balance'
        );
        throw error;
      }
    }, `getTokenBalance(${contractAddress}, ${walletAddress})`);
  }

  /**
   * Calculate human-readable amount from raw amount
   */
  calculateHumanAmount(amountRaw: string, decimals: number): string {
    return ethers.formatUnits(amountRaw, decimals);
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
          {
            attempt: attempt + 1,
            error: error.message,
            operation,
            chain: 'bsc',
          },
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


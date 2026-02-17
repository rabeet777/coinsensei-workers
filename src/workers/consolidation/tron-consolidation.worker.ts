import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../config/supabase.js';
import { SignerService } from '../../services/signer.service.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import type {
  ConsolidationJob,
  WalletBalanceValidation,
  OperationWalletAddress,
} from '../../types/consolidation-queue.js';
import {
  WorkerRuntime,
  workerIdentity,
  defaultHeartbeatIntervalMs,
} from '../../control-plane/worker-runtime.js';

export class TronConsolidationWorker {
  private supabase: SupabaseClient;
  private signerService: SignerService;
  private runtime: WorkerRuntime | null = null;
  private isRunning: boolean = false;
  private stopHeartbeat: (() => void) | null = null;
  private readonly POLL_INTERVAL_MS = 15000; // 15 seconds
  private readonly MAX_RETRIES = 8;
  private readonly LOCK_DURATION_MINUTES = 10;
  private chainId: string = '';

  constructor() {
    this.supabase = getSupabaseClient();
    this.signerService = new SignerService('tron-consolidation-worker');
  }

  get WORKER_ID(): string {
    return this.runtime?.workerId ?? `tron_consol_${process.pid}`;
  }

  async initialize(): Promise<void> {
    logger.info('Initializing TRON Consolidation Worker...');

    const { data: chain, error } = await this.supabase
      .from('chains')
      .select('id, name')
      .eq('name', 'tron')
      .eq('is_active', true)
      .maybeSingle();

    if (error || !chain) {
      throw new Error(`Failed to load TRON chain config: ${error?.message}`);
    }

    this.chainId = chain.id;
    this.runtime = new WorkerRuntime(
      workerIdentity('consolidation_execute', this.chainId)
    );
    await this.runtime.register();

    const signerHealthy = await this.signerService.healthCheck();
    if (!signerHealthy) {
      logger.warn('Signer service health check failed - consolidations may fail');
    }

    logger.info(
      {
        workerId: this.WORKER_ID,
        chainId: this.chainId,
        maxRetries: this.MAX_RETRIES,
        signerHealthy,
      },
      'TRON Consolidation Worker initialized successfully'
    );
  }

  /**
   * Main processing loop
   */
  async processBatch(): Promise<void> {
    try {
      const job = await this.pickNextJob();

      if (!job) {
        return;
      }

      logger.info(
        {
          jobId: job.id,
          walletBalanceId: job.wallet_balance_id,
          amount: job.amount_human,
          priority: job.priority,
        },
        'Processing consolidation job'
      );

      await this.processJob(job);
    } catch (error: any) {
      logger.error(
        { error: error.message },
        'Error in consolidation batch processing'
      );
    }
  }

  /**
   * Pick next pending job for TRON chain
   */
  private async pickNextJob(): Promise<ConsolidationJob | null> {
    try {
      const { data: candidates, error } = await this.supabase
        .from('consolidation_queue')
        .select('*')
        .eq('chain_id', this.chainId)
        .eq('status', 'pending')
        .lte('scheduled_at', new Date().toISOString())
        .limit(25);

      if (error) {
        logger.error({ error: error.message }, 'Failed to fetch candidate jobs');
        return null;
      }

      if (!candidates || candidates.length === 0) {
        return null;
      }

      // Sort by priority and scheduled_at
      const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };
      const priorityRank = (priority: string): number => {
        return PRIORITY_RANK[priority] ?? 3;
      };

      candidates.sort((a, b) => {
        const rankA = priorityRank(a.priority);
        const rankB = priorityRank(b.priority);
        if (rankA !== rankB) {
          return rankA - rankB;
        }
        return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
      });

      return candidates[0] as ConsolidationJob;
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error picking consolidation job');
      return null;
    }
  }

  /**
   * Process a single consolidation job
   */
  private async processJob(job: ConsolidationJob): Promise<void> {
    let lockAcquired = false;
    
    try {
      // Step 1: Pre-execution validation
      const isValid = await this.validateWalletState(job);
      if (!isValid) {
        await this.markJobFailed(
          job.id,
          'Wallet state validation failed (needs_gas=true or already locked)'
        );
        return;
      }

      // Step 2: Acquire consolidation lock
      lockAcquired = await this.acquireConsolidationLock(job);
      if (!lockAcquired) {
        logger.warn(
          { jobId: job.id, walletBalanceId: job.wallet_balance_id },
          'Could not acquire consolidation lock, skipping job'
        );
        return;
      }

      // Step 3: Update job status to processing
      await this.updateJobStatus(job.id, 'processing');

      // Step 4: Execute consolidation transaction
      await this.executeConsolidation(job);
    } catch (error: any) {
      // Release lock on error (confirmation worker will release on success)
      if (lockAcquired) {
        await this.releaseConsolidationLock(job.wallet_balance_id);
      }
      await this.handleJobError(job, error);
    }
  }

  /**
   * Validate wallet state before processing
   */
  private async validateWalletState(job: ConsolidationJob): Promise<boolean> {
    try {
      const { data: walletBalance, error } = await this.supabase
        .from('wallet_balances')
        .select('id, needs_consolidation, needs_gas, processing_status, consolidation_locked_until, consolidation_locked_by')
        .eq('id', job.wallet_balance_id)
        .maybeSingle();

      if (error || !walletBalance) {
        logger.error(
          { jobId: job.id, walletBalanceId: job.wallet_balance_id, error: error?.message },
          'Failed to load wallet balance for validation'
        );
        return false;
      }

      // Validate state
      if (!walletBalance.needs_consolidation) {
        logger.warn(
          { jobId: job.id, walletBalanceId: job.wallet_balance_id },
          'Wallet does not need consolidation'
        );
        return false;
      }

      if (walletBalance.needs_gas) {
        logger.warn(
          { jobId: job.id, walletBalanceId: job.wallet_balance_id },
          'Wallet needs gas, cannot consolidate'
        );
        return false;
      }

      if (walletBalance.processing_status !== 'idle') {
        logger.warn(
          { jobId: job.id, walletBalanceId: job.wallet_balance_id, status: walletBalance.processing_status },
          'Wallet is not idle'
        );
        return false;
      }

      if (walletBalance.consolidation_locked_until) {
        const lockExpired = new Date(walletBalance.consolidation_locked_until) < new Date();
        if (!lockExpired) {
          logger.warn(
            { jobId: job.id, walletBalanceId: job.wallet_balance_id },
            'Wallet consolidation lock is still active'
          );
          return false;
        }
      }

      return true;
    } catch (error: any) {
      logger.error(
        { error: error.message, jobId: job.id },
        'Error validating wallet state'
      );
      return false;
    }
  }

  /**
   * Acquire consolidation lock on wallet_balances
   */
  private async acquireConsolidationLock(job: ConsolidationJob): Promise<boolean> {
    try {
      const lockUntil = new Date(
        Date.now() + this.LOCK_DURATION_MINUTES * 60 * 1000
      ).toISOString();

      const { data, error } = await this.supabase
        .from('wallet_balances')
        .update({
          processing_status: 'consolidating',
          consolidation_locked_until: lockUntil,
          consolidation_locked_by: this.WORKER_ID,
        })
        .eq('id', job.wallet_balance_id)
        .eq('processing_status', 'idle')
        .select();

      if (error) {
        logger.error(
          { error: error.message, jobId: job.id },
          'Failed to acquire consolidation lock'
        );
        return false;
      }

      if (!data || data.length === 0) {
        logger.debug(
          { jobId: job.id, walletBalanceId: job.wallet_balance_id },
          'Lock not acquired - wallet may be processing'
        );
        return false;
      }

      logger.debug(
        { jobId: job.id, walletBalanceId: job.wallet_balance_id },
        'Consolidation lock acquired'
      );

      return true;
    } catch (error: any) {
      logger.error(
        { error: error.message, jobId: job.id },
        'Error acquiring consolidation lock'
      );
      return false;
    }
  }

  /**
   * Execute consolidation transaction
   */
  private async executeConsolidation(job: ConsolidationJob): Promise<void> {
    // Load source wallet (user wallet)
    const sourceWallet = await this.loadSourceWallet(job.wallet_id, job.chain_id);
    if (!sourceWallet) {
      throw new Error('Source wallet not found');
    }

    // Load destination wallet (hot wallet)
    const destWallet = await this.loadDestinationWallet(job.operation_wallet_address_id);
    if (!destWallet) {
      throw new Error('Destination wallet not found');
    }

    // Load asset information to determine if native or token
    const asset = await this.loadAssetInfo(job.wallet_balance_id);
    if (!asset) {
      throw new Error('Asset information not found');
    }

    logger.info(
      {
        jobId: job.id,
        from: sourceWallet.address,
        to: destWallet.address,
        amount: job.amount_human,
        assetType: asset.is_native ? 'Native TRX' : 'TRC20 Token',
        contractAddress: asset.contract_address || 'N/A',
      },
      'Executing TRON consolidation'
    );

    // Build transaction intent based on asset type
    let txIntent: any;
    if (asset.is_native) {
      // Native TRX transfer
      txIntent = {
        type: 'send_trx',
        from: sourceWallet.address,
        to: destWallet.address,
        amount_sun: job.amount_raw,
      };
    } else {
      // TRC20 token transfer
      if (!asset.contract_address) {
        throw new Error('Token contract address is required for TRC20 consolidation');
      }
      txIntent = {
        type: 'trc20_transfer',
        from: sourceWallet.address,
        to: destWallet.address,
        contract_address: asset.contract_address,
        amount: job.amount_raw, // Amount in smallest unit
      };
    }

    // Call signer service (build, sign, and broadcast)
    logger.debug(
      {
        jobId: job.id,
        txType: txIntent.type,
        contractAddress: txIntent.contract_address || 'N/A',
      },
      'Requesting transaction from signer service'
    );

    const signerResult = await this.signerService.signTransaction({
      chain: 'tron',
      wallet_group_id: sourceWallet.wallet_group_id,
      derivation_index: sourceWallet.derivation_index,
      tx_intent: txIntent,
    });

    const txHash = signerResult.tx_hash || (signerResult as any).txHash || (signerResult as any).tx_id || (signerResult as any).txid;

    if (!txHash) {
      logger.error(
        { jobId: job.id, signerResponse: signerResult },
        'Signer service did not return txHash'
      );
      throw new Error('Signer service did not return txHash');
    }

    logger.info(
      { jobId: job.id, txHash },
      'Consolidation transaction broadcasted successfully'
    );

    // Update job with tx_hash and move to confirming
    await this.updateJobTxHash(job.id, txHash);
  }

  /**
   * Load source wallet address (user wallet)
   */
  private async loadSourceWallet(walletId: string, chainId: string): Promise<any> {
    const { data, error } = await this.supabase
      .from('user_wallet_addresses')
      .select('address, wallet_group_id, derivation_index, is_active')
      .eq('id', walletId)
      .eq('chain_id', chainId)
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      logger.error(
        { error: error.message, walletId, chainId },
        'Error loading source wallet'
      );
      throw error;
    }

    return data;
  }

  /**
   * Load destination wallet address (hot wallet)
   */
  private async loadDestinationWallet(
    operationWalletAddressId: string
  ): Promise<OperationWalletAddress | null> {
    const { data, error } = await this.supabase
      .from('operation_wallet_addresses')
      .select('*')
      .eq('id', operationWalletAddressId)
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      logger.error(
        { error: error.message, operationWalletAddressId },
        'Error loading destination wallet'
      );
      throw error;
    }

    return data;
  }

  /**
   * Load asset information from wallet_balances and asset_on_chain
   */
  private async loadAssetInfo(walletBalanceId: string): Promise<{
    is_native: boolean;
    contract_address: string | null;
    decimals: number;
  } | null> {
    try {
      // Load wallet_balances to get asset_on_chain_id
      const { data: walletBalance, error: wbError } = await this.supabase
        .from('wallet_balances')
        .select('asset_on_chain_id')
        .eq('id', walletBalanceId)
        .maybeSingle();

      if (wbError || !walletBalance) {
        logger.error(
          { error: wbError?.message, walletBalanceId },
          'Error loading wallet_balances for asset info'
        );
        return null;
      }

      // Load asset_on_chain to get asset details
      const { data: assetOnChain, error: aocError } = await this.supabase
        .from('asset_on_chain')
        .select('is_native, contract_address, decimals')
        .eq('id', walletBalance.asset_on_chain_id)
        .maybeSingle();

      if (aocError || !assetOnChain) {
        logger.error(
          { error: aocError?.message, assetOnChainId: walletBalance.asset_on_chain_id },
          'Error loading asset_on_chain'
        );
        return null;
      }

      logger.debug(
        {
          walletBalanceId,
          assetOnChainId: walletBalance.asset_on_chain_id,
          isNative: assetOnChain.is_native,
          contractAddress: assetOnChain.contract_address,
        },
        'Asset info loaded'
      );

      return assetOnChain;
    } catch (error: any) {
      logger.error(
        { error: error.message, walletBalanceId },
        'Error loading asset info'
      );
      return null;
    }
  }

  /**
   * Update job status
   */
  private async updateJobStatus(jobId: string, status: string): Promise<void> {
    const updates: any = {
      status,
    };

    if (status === 'processing') {
      updates.retry_count = await this.getRetryCount(jobId);
    }

    const { error } = await this.supabase
      .from('consolidation_queue')
      .update(updates)
      .eq('id', jobId);

    if (error) {
      throw new Error(`Failed to update job status: ${error.message}`);
    }
  }

  /**
   * Get current retry count
   */
  private async getRetryCount(jobId: string): Promise<number> {
    const { data } = await this.supabase
      .from('consolidation_queue')
      .select('retry_count')
      .eq('id', jobId)
      .maybeSingle();

    return (data?.retry_count || 0) + 1;
  }

  /**
   * Update job with transaction hash and move to confirming
   */
  private async updateJobTxHash(jobId: string, txHash: string): Promise<void> {
    const { error } = await this.supabase
      .from('consolidation_queue')
      .update({
        tx_hash: txHash,
        status: 'confirming',
        processed_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    if (error) {
      throw new Error(`Failed to update job tx_hash: ${error.message}`);
    }
  }

  /**
   * Mark job as failed (non-retryable)
   */
  private async markJobFailed(jobId: string, errorMessage: string): Promise<void> {
    const { error } = await this.supabase
      .from('consolidation_queue')
      .update({
        status: 'failed',
        error_message: errorMessage,
        processed_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    if (error) {
      logger.error({ error: error.message, jobId }, 'Failed to mark job as failed');
    }
  }

  /**
   * Release consolidation lock on error
   */
  private async releaseConsolidationLock(walletBalanceId: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('wallet_balances')
        .update({
          processing_status: 'idle',
          consolidation_locked_until: null,
          consolidation_locked_by: null,
        })
        .eq('id', walletBalanceId)
        .eq('consolidation_locked_by', this.WORKER_ID);

      if (error) {
        logger.error(
          { error: error.message, walletBalanceId },
          'Failed to release consolidation lock'
        );
      } else {
        logger.debug(
          { walletBalanceId },
          'Released consolidation lock after error'
        );
      }
    } catch (error: any) {
      logger.error(
        { error: error.message, walletBalanceId },
        'Error releasing consolidation lock'
      );
    }
  }

  /**
   * Handle job error with retry logic
   */
  private async handleJobError(job: ConsolidationJob, error: any): Promise<void> {
    const retryCount = (job.retry_count || 0) + 1;
    const isRetryable = error.isRetryable !== false && retryCount < this.MAX_RETRIES;

    logger.error(
      {
        jobId: job.id,
        error: error.message,
        retryCount,
        maxRetries: this.MAX_RETRIES,
        isRetryable,
      },
      'Consolidation job error'
    );

    if (isRetryable) {
      // Calculate backoff
      const baseBackoffMs = 30000; // 30 seconds
      const maxBackoffMs = 15 * 60 * 1000; // 15 minutes
      const backoffMs = Math.min(
        Math.pow(2, retryCount) * baseBackoffMs,
        maxBackoffMs
      );
      const scheduledAt = new Date(Date.now() + backoffMs).toISOString();

      // Mark for retry
      const { error: updateError } = await this.supabase
        .from('consolidation_queue')
        .update({
          status: 'pending',
          retry_count: retryCount,
          error_message: error.message,
          scheduled_at: scheduledAt,
        })
        .eq('id', job.id);

      if (updateError) {
        logger.error(
          { error: updateError.message, jobId: job.id },
          'Failed to update job for retry'
        );
      }
    } else {
      // Mark as failed
      await this.markJobFailed(job.id, error.message);
    }
  }

  /**
   * Start the worker loop
   */
  async start(): Promise<void> {
    if (this.isRunning || !this.runtime) {
      if (!this.runtime) logger.warn('Worker not initialized');
      else if (this.isRunning) logger.warn('TRON Consolidation Worker already running');
      return;
    }

    this.isRunning = true;
    this.stopHeartbeat = this.runtime.startHeartbeat(
      defaultHeartbeatIntervalMs()
    );
    logger.info({ workerId: this.WORKER_ID }, 'Starting TRON Consolidation Worker loop');

    while (this.isRunning) {
      const cycleStart = Date.now();
      try {
        const inMaintenance = await this.runtime.checkMaintenance();
        if (inMaintenance) {
          await this.runtime.setPaused();
          await this.runtime.logExecution({
            executionType: 'cycle',
            status: 'skip',
            durationMs: Date.now() - cycleStart,
            metadata: { reason: 'maintenance' },
          });
          await sleep(this.POLL_INTERVAL_MS);
          continue;
        }

        const incidentAllowed = await this.runtime.checkIncidentModeAllowed();
        if (!incidentAllowed) {
          await this.runtime.setPaused();
          const config = await this.runtime.getIncidentConfig();
          await this.runtime.logExecution({
            executionType: 'cycle',
            status: 'skip',
            durationMs: Date.now() - cycleStart,
            metadata: { reason: 'incident_mode', mode: config.mode },
          });
          await sleep(this.POLL_INTERVAL_MS);
          continue;
        }

        await this.processBatch();
        await this.runtime.logExecution({
          executionType: 'cycle',
          status: 'success',
          durationMs: Date.now() - cycleStart,
        });
      } catch (error: any) {
        logger.error(
          { error: error.message },
          'Error in TRON consolidation worker loop'
        );
        await this.runtime.logExecution({
          executionType: 'cycle',
          status: 'fail',
          durationMs: Date.now() - cycleStart,
          errorMessage: error?.message ?? String(error),
        });
      }

      await sleep(this.POLL_INTERVAL_MS);
    }

    this.stopHeartbeat?.();
    await this.runtime.setStopped();
  }

  /**
   * Stop the worker loop
   */
  stop(): void {
    logger.info({ workerId: this.WORKER_ID }, 'Stopping TRON Consolidation Worker');
    this.isRunning = false;
  }

  /** Graceful shutdown: stop loop and update worker_status to stopped. Call from signal handler before process.exit(). */
  async shutdown(): Promise<void> {
    this.stop();
    if (this.runtime) await this.runtime.setStopped();
  }
}


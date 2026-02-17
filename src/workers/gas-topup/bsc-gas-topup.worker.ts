import { ethers } from 'ethers';
import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../config/supabase.js';
import { SignerService } from '../../services/signer.service.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import type { GasTopupJob, OperationWalletAddress } from '../../types/gas-topup-queue.js';
import {
  WorkerRuntime,
  workerIdentity,
  defaultHeartbeatIntervalMs,
} from '../../control-plane/worker-runtime.js';

export class BscGasTopupWorker {
  private supabase: SupabaseClient;
  private provider!: ethers.JsonRpcProvider;
  private signerService: SignerService;
  private runtime: WorkerRuntime | null = null;
  private isRunning: boolean = false;
  private stopHeartbeat: (() => void) | null = null;
  private readonly GAS_LOCK_DURATION_MINUTES = 5;
  private readonly POLL_INTERVAL_MS = 15000; // 15 seconds
  private readonly MAX_RETRIES = 8;
  private readonly CONFIRMATION_BLOCKS = 3; // Configurable
  private readonly GAS_LIMIT = 21000; // Standard ETH transfer
  private readonly MAX_GAS_PRICE_GWEI = 20; // Cap gas price
  private readonly GAS_PRICE_BUMP_PERCENT = 15; // For replacements
  private readonly CONFIRM_RETRY_DELAY_MS = 20000; // 20 seconds - FIX 2
  private rpcUrl: string = '';
  private chainId: string = '';
  
  // Nonce race protection - per-funder locks (in-process, for single-worker deployments)
  // For multi-worker deployments, use Postgres advisory locks (see acquireEvmFunderLock)
  private nonceLocks: Map<string, Promise<void>> = new Map();

  constructor() {
    this.supabase = getSupabaseClient();
    this.signerService = new SignerService('bsc-gas-worker');
  }

  get WORKER_ID(): string {
    return this.runtime?.workerId ?? `bsc_gas_topup_${process.pid}`;
  }

  /**
   * Initialize worker
   */
  async initialize(): Promise<void> {
    logger.info('Initializing BSC Gas Top-Up Worker...');

    // Load BSC chain configuration
    const { data: chain, error } = await this.supabase
      .from('chains')
      .select('id, name, rpc_url')
      .eq('name', 'bsc')
      .eq('is_active', true)
      .maybeSingle();

    if (error || !chain) {
      throw new Error(`Failed to load BSC chain config: ${error?.message}`);
    }

    this.rpcUrl = chain.rpc_url;
    this.chainId = chain.id;
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
    this.runtime = new WorkerRuntime(
      workerIdentity('gas_topup_execute', this.chainId)
    );
    await this.runtime.register();

    // FIX 5: BSC CHAIN ID VALIDATION - Prevent silent signing on wrong chain
    const { data: chainConfig } = await this.supabase
      .from('chains')
      .select('chain_id')
      .eq('id', chain.id)
      .maybeSingle();

    if (chainConfig?.chain_id) {
      const chainId = typeof chainConfig.chain_id === 'number' 
        ? chainConfig.chain_id 
        : parseInt(chainConfig.chain_id.toString(), 10);
      
      if (!Number.isInteger(chainId)) {
        throw new Error(`Invalid BSC_CHAIN_ID: ${chainConfig.chain_id}`);
      }
      
      logger.info({ chainId }, 'BSC chain ID validated');
    }

    // Check signer service health
    const signerHealthy = await this.signerService.healthCheck();
    if (!signerHealthy) {
      logger.warn('Signer service health check failed - transactions may fail');
    }

    logger.info(
      {
        workerId: this.WORKER_ID,
        rpcUrl: this.rpcUrl,
        signerHealthy,
      },
      'BSC Gas Top-Up Worker initialized successfully'
    );
  }

  /**
   * Process batch of gas top-up jobs
   * Jobs are picked one at a time to ensure proper gas locking
   */
  async processBatch(): Promise<void> {
    try {
      // Pick ONE job (gas locking happens at wallet level, not job level)
      const job = await this.pickNextJob();

      if (!job) {
        logger.debug('No BSC gas top-up jobs to process');
        return;
      }

      logger.info(
        {
          jobId: job.id,
          walletId: job.wallet_id,
          status: job.status,
          workerId: this.WORKER_ID,
        },
        'Picked BSC gas top-up job'
      );

      // Process the job with gas locking
      await this.processJobWithGasLock(job);
    } catch (error: any) {
      logger.error(
        { error: error.message },
        'Error processing BSC gas top-up'
      );
    }
  }

  /**
   * Pick next job from gas_topup_queue
   * A) JOB PICKING (NO queue locks)
   * - Fetch 25 candidates, sort in code by priority, pick first
   * - NO row-level locking here - locking happens at wallet_balances level
   */
  private async pickNextJob(): Promise<GasTopupJob | null> {
    try {
      // Load BSC chain ID
      const { data: chain } = await this.supabase
        .from('chains')
        .select('id')
        .eq('name', 'bsc')
        .maybeSingle();

      if (!chain) {
        return null;
      }

      // A) Fetch up to 25 candidate jobs
      const { data: candidates, error } = await this.supabase
        .from('gas_topup_queue')
        .select('*')
        .eq('chain_id', chain.id)
        .in('status', ['pending', 'confirming'])
        .lte('scheduled_at', new Date().toISOString())
        .limit(25);

      if (error) {
        logger.error({ error: error.message }, 'Failed to fetch candidate jobs');
        return null;
      }

      if (!candidates || candidates.length === 0) {
        return null;
      }

      // FIX 1: Sort in code using priority rank map
      const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };
      const priorityRank = (priority: string | number | null): number => {
        const priorityStr = typeof priority === 'number' ? String(priority) : priority;
        if (priorityStr && PRIORITY_RANK[priorityStr] !== undefined) {
          return PRIORITY_RANK[priorityStr];
        }
        return 3; // unknown
      };

      candidates.sort((a, b) => {
        const rankA = priorityRank(a.priority);
        const rankB = priorityRank(b.priority);
        if (rankA !== rankB) {
          return rankA - rankB;
        }
        // Same priority, sort by scheduled_at ASC
        return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
      });

      // Pick the first job from sorted list
      const job = candidates[0] as GasTopupJob;

      // B) STATUS TRANSITIONS
      // If tx_hash is NULL -> status='processing'
      // If tx_hash is NOT NULL -> status='confirming'
      const newStatus = job.tx_hash ? 'confirming' : 'processing';
      
      await this.supabase
        .from('gas_topup_queue')
        .update({ status: newStatus })
        .eq('id', job.id);

      return job;
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error picking job');
      return null;
    }
  }

  /**
   * Process job with wallet-level gas locking
   * CRITICAL: Gas lock must be acquired at wallet_balances level, not job level
   */
  private async processJobWithGasLock(job: GasTopupJob): Promise<void> {
    let gasLockAcquired = false;

    try {
      // C) CRITICAL: Acquire gas lock at wallet_balances level
      gasLockAcquired = await this.acquireGasLock(job.wallet_id, job.gas_asset_id, job.chain_id);

      if (!gasLockAcquired) {
        logger.debug(
          { jobId: job.id, walletId: job.wallet_id },
          'Could not acquire gas lock - another worker owns it, skipping'
        );
        // Do NOT change queue state further, just continue loop
        return;
      }

      // Process with lock held
      await this.processJob(job);
    } catch (error: any) {
      logger.error(
        { error: error.message, jobId: job.id },
        'Error processing job with gas lock'
      );
      await this.handleJobError(job, error);
    } finally {
      // H) ALWAYS release gas lock in all exit paths
      if (gasLockAcquired) {
        await this.releaseGasLock(job.wallet_id, job.gas_asset_id, job.chain_id);
      }
    }
  }

  /**
   * Acquire gas lock at wallet_balances level
   * C) GAS LOCK ACQUIRE (CRITICAL)
   * - Resolve native gas asset_on_chain_id by joining asset_on_chain
   * - Find asset_on_chain_id WHERE chain_id=job.chain_id AND asset_id=job.gas_asset_id
   * - Returns true if lock acquired, false if another worker owns it
   */
  private async acquireGasLock(
    walletId: string,
    gasAssetId: string,
    chainId: string
  ): Promise<boolean> {
    try {
      // C) Resolve native gas asset_on_chain_id
      const { data: gasAssetOnChain } = await this.supabase
        .from('asset_on_chain')
        .select('id')
        .eq('chain_id', chainId)
        .eq('asset_id', gasAssetId)
        .maybeSingle();

      if (!gasAssetOnChain) {
        logger.error({ gasAssetId, chainId }, 'Could not find gas asset_on_chain');
        return false;
      }

      const lockUntil = new Date(
        Date.now() + this.GAS_LOCK_DURATION_MINUTES * 60 * 1000
      ).toISOString();

      // Attempt to acquire lock
      // WHERE wallet_id = job.wallet_id
      //   AND asset_on_chain_id = <resolved gas asset_on_chain_id>
      //   AND (gas_locked_until IS NULL OR gas_locked_until < now())
      const { data, error } = await this.supabase
        .from('wallet_balances')
        .update({
          gas_locked_until: lockUntil,
          gas_locked_by: this.WORKER_ID,
          processing_status: 'gas_processing',
        })
        .eq('wallet_id', walletId)
        .eq('asset_on_chain_id', gasAssetOnChain.id)
        .or(`gas_locked_until.is.null,gas_locked_until.lt.${new Date().toISOString()}`)
        .select();

      if (error || !data || data.length === 0) {
        // Lock not acquired - another worker owns it
        return false;
      }

      logger.debug(
        { walletId, assetOnChainId: gasAssetOnChain.id, workerId: this.WORKER_ID },
        'Acquired gas lock at wallet level'
      );

      return true;
    } catch (error: any) {
      logger.error(
        { error: error.message, walletId },
        'Error acquiring gas lock'
      );
      return false;
    }
  }

  /**
   * Release gas lock at wallet_balances level
   * H) RELEASE GAS LOCK (ALWAYS) - In finally block
   */
  private async releaseGasLock(
    walletId: string,
    gasAssetId: string,
    chainId: string,
    success: boolean = false
  ): Promise<void> {
    try {
      // Resolve asset_on_chain_id
      const { data: gasAssetOnChain } = await this.supabase
        .from('asset_on_chain')
        .select('id')
        .eq('chain_id', chainId)
        .eq('asset_id', gasAssetId)
        .maybeSingle();

      if (!gasAssetOnChain) {
        logger.warn({ walletId, gasAssetId, chainId }, 'Could not resolve asset_on_chain_id for lock release');
        return;
      }

      const updates: any = {
        gas_locked_until: null,
        gas_locked_by: null,
        processing_status: 'idle',
        last_processed_at: new Date().toISOString(),
      };

      if (success) {
        updates.needs_gas = false;
      }

      // H) Release lock: WHERE wallet_id=job.wallet_id AND asset_on_chain_id=<gas asset_on_chain_id> AND gas_locked_by=WORKER_ID
      await this.supabase
        .from('wallet_balances')
        .update(updates)
        .eq('wallet_id', walletId)
        .eq('asset_on_chain_id', gasAssetOnChain.id)
        .eq('gas_locked_by', this.WORKER_ID);

      logger.debug(
        { walletId, success },
        'Released gas lock'
      );
    } catch (error: any) {
      logger.error(
        { error: error.message, walletId },
        'Error releasing gas lock'
      );
    }
  }

  /**
   * Acquire Postgres advisory lock for EVM funder (nonce serialization)
   * BSC-SPECIFIC: Per-funder serialization using Postgres advisory locks
   */
  private async acquireEvmFunderLock(fundingAddress: string): Promise<void> {
    try {
      const { error } = await this.supabase.rpc('lock_evm_funder', {
        key: fundingAddress.toLowerCase(),
      });

      if (error) {
        logger.error(
          { error: error.message, fundingAddress },
          'Failed to acquire EVM funder advisory lock'
        );
        throw new Error(`Failed to acquire EVM funder lock: ${error.message}`);
      }

      logger.debug({ fundingAddress }, 'Acquired EVM funder advisory lock');
    } catch (error: any) {
      logger.error(
        { error: error.message, fundingAddress },
        'Error acquiring EVM funder lock'
      );
      throw error;
    }
  }

  /**
   * Release Postgres advisory lock for EVM funder
   */
  private async releaseEvmFunderLock(fundingAddress: string): Promise<void> {
    try {
      const { error } = await this.supabase.rpc('unlock_evm_funder', {
        key: fundingAddress.toLowerCase(),
      });

      if (error) {
        logger.error(
          { error: error.message, fundingAddress },
          'Failed to release EVM funder advisory lock'
        );
        // Don't throw - best effort release
      } else {
        logger.debug({ fundingAddress }, 'Released EVM funder advisory lock');
      }
    } catch (error: any) {
      logger.error(
        { error: error.message, fundingAddress },
        'Error releasing EVM funder lock'
      );
      // Don't throw - best effort release
    }
  }

  /**
   * Process a single gas top-up job through state machine
   * F) IDEMPOTENCY (CRITICAL): If tx_hash exists => NEVER build/sign/broadcast again, only confirm
   * G) RETRY: MAX_RETRIES=8, exponential backoff
   */
  private async processJob(job: GasTopupJob): Promise<void> {
    try {
      logger.info(
        {
          jobId: job.id,
          walletId: job.wallet_id,
          status: job.status,
          amount: job.topup_amount_human,
          attemptCount: job.retry_count || 0,
          txHash: job.tx_hash || null,
        },
        'Processing BSC gas top-up job'
      );

      // FIX 2: IDEMPOTENCY - If tx_hash exists, only confirm
      if (job.tx_hash && job.status !== 'failed') {
        logger.info(
          { jobId: job.id, txHash: job.tx_hash, status: job.status },
          'Transaction already exists - resuming confirmation only'
        );

        // Ensure status is confirming
        if (job.status !== 'confirming' && job.status !== 'confirmed') {
          await this.supabase
            .from('gas_topup_queue')
            .update({ status: 'confirming' })
            .eq('id', job.id);
        }

        await this.confirmTransaction(job);
        return;
      }

      // Attempt limit enforcement
      const retryCount = job.retry_count || 0;
      if (retryCount >= this.MAX_RETRIES) {
        logger.error(
          { jobId: job.id, retryCount, maxRetries: this.MAX_RETRIES },
          'Max retries exceeded - marking as failed'
        );

        // FIX 1: Only update valid columns: status, processed_at
        await this.supabase
          .from('gas_topup_queue')
          .update({
            status: 'failed',
            processed_at: new Date().toISOString(),
          })
          .eq('id', job.id);
        return;
      }

      // FIX 2: COLLAPSE STATUS MACHINE - Only use: pending, processing, confirming, confirmed, failed, cancelled
      if (job.status === 'pending' || job.status === 'processing') {
        // If tx_hash IS NULL: build → sign → broadcast → store tx_hash → status = 'confirming'
        if (!job.tx_hash) {
          await this.executeNewJob(job);
        } else {
          // If tx_hash EXISTS: status = 'confirming', confirm only
          await this.supabase
            .from('gas_topup_queue')
            .update({ status: 'confirming' })
            .eq('id', job.id);
          await this.confirmTransaction(job);
        }
      } else if (job.status === 'confirming') {
        // If tx_hash EXISTS: confirm only
        await this.confirmTransaction(job);
      } else if (job.status === 'confirmed') {
        // Already confirmed, nothing to do
        logger.debug({ jobId: job.id }, 'Job already confirmed');
      } else {
        logger.warn(
          { jobId: job.id, status: job.status },
          'Job in unexpected state'
        );
      }
    } catch (error: any) {
      await this.handleJobError(job, error);
    }
  }

  /**
   * Execute a new gas top-up job
   * BSC-SPECIFIC: Per-funder serialization using Postgres advisory locks
   */
  private async executeNewJob(job: GasTopupJob): Promise<void> {
    // E) Load funding wallet address
    const fundingWallet = await this.loadOperationWalletAddress(
      job.operation_wallet_address_id,
      job.chain_id
    );

    if (!fundingWallet) {
      // E) If not found => retryable error
      const error: any = new Error('Funding wallet address not found');
      error.isRetryable = true;
      error.errorType = 'funding_wallet_not_found';
      throw error;
    }

    // FIX 4: BSC ADVISORY LOCK SAFETY - Wrap in try/finally, do NOT rely on outer finally blocks
    await this.acquireEvmFunderLock(fundingWallet.address);
    try {
      await this.executeWithNonceLock(job, fundingWallet);
    } finally {
      await this.releaseEvmFunderLock(fundingWallet.address);
    }
  }

  /**
   * Execute job with nonce lock held
   */
  private async executeWithNonceLock(
    job: GasTopupJob,
    fundingWallet: OperationWalletAddress
  ): Promise<void> {
    // D) Load target wallet address
    const targetWallet = await this.loadTargetWalletAddress(job.wallet_id, job.chain_id);

    if (!targetWallet) {
      // D) If not found => set status='failed', processed_at=now(), error_message
      // FIX 1: Only update valid columns: status, processed_at, error_message
      await this.supabase
        .from('gas_topup_queue')
        .update({
          status: 'failed',
          processed_at: new Date().toISOString(),
          error_message: 'Target wallet address not found',
        })
        .eq('id', job.id);
      throw new Error('Target wallet address not found');
    }

    logger.info(
      {
        jobId: job.id,
        from: fundingWallet.address,
        to: targetWallet,
        amount: job.topup_amount_human,
      },
      'Loaded wallet addresses for BSC gas top-up'
    );

    // Validate funding wallet balance
    await this.validateFundingBalance(fundingWallet.address, job.topup_amount_raw);

    // FIX 5c: Gas spike protection
    const gasPrice = await this.getGasPrice();
    const maxGasPrice = ethers.parseUnits(this.MAX_GAS_PRICE_GWEI.toString(), 'gwei');
    
    if (gasPrice > maxGasPrice) {
      const error: any = new Error(
        `Gas price too high: ${ethers.formatUnits(gasPrice, 'gwei')} > ${this.MAX_GAS_PRICE_GWEI} Gwei`
      );
      error.isRetryable = true;
      error.errorType = 'gas_spike';
      throw error;
    }

    // FIX 2: Set status to 'processing' before building transaction
    await this.supabase
      .from('gas_topup_queue')
      .update({ status: 'processing' })
      .eq('id', job.id);

    // Build unsigned transaction (with nonce, gas price)
    const unsignedTx = await this.buildUnsignedTransaction(
      fundingWallet.address,
      targetWallet,
      job.topup_amount_raw || ethers.parseEther(job.topup_amount_human).toString(),
      job,
      gasPrice
    );

    // Sign transaction via signer service
    const signedTx = await this.signTransaction(fundingWallet, unsignedTx);

    // Broadcast transaction with replacement handling
    const txHash = await this.broadcastTransactionWithReplacement(signedTx, job, unsignedTx);

    // FIX 2: Store tx_hash and set status to 'confirming'
    // FIX 1: Only update valid columns: tx_hash, status
    await this.supabase
      .from('gas_topup_queue')
      .update({
        tx_hash: txHash,
        status: 'confirming',
      })
      .eq('id', job.id);

    // Confirm transaction
    await this.confirmTransaction({ ...job, tx_hash: txHash });
  }

  /**
   * Load operation wallet address (funding wallet)
   * E) FUNDING WALLET RESOLUTION (AUTHORITATIVE)
   * - Load from operation_wallet_addresses by id = job.operation_wallet_address_id AND chain_id = job.chain_id AND is_active = true
   * - Use (address, wallet_group_id, derivation_index)
   */
  private async loadOperationWalletAddress(
    id: string,
    chainId: string
  ): Promise<OperationWalletAddress | null> {
    const { data, error } = await this.supabase
      .from('operation_wallet_addresses')
      .select('*')
      .eq('id', id)
      .eq('chain_id', chainId)
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      logger.error({ error: error.message, id, chainId }, 'Failed to load operation wallet address');
      return null;
    }

    return data as OperationWalletAddress | null;
  }

  /**
   * Load target wallet address from user_wallet_addresses
   * D) TARGET ADDRESS RESOLUTION (CORRECT)
   * - gas_topup_queue.wallet_id corresponds to user_wallet_addresses.id (NOT uid)
   * - SELECT address, uid, chain_id, wallet_group_id, derivation_index
   * - FROM user_wallet_addresses WHERE id = job.wallet_id AND chain_id = job.chain_id AND is_active = true
   */
  private async loadTargetWalletAddress(
    walletId: string,
    chainId: string
  ): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('user_wallet_addresses')
      .select('address, uid, chain_id, wallet_group_id, derivation_index, is_active')
      .eq('id', walletId) // D) CRITICAL: Use id, NOT uid
      .eq('chain_id', chainId)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !data) {
      logger.error(
        { error: error?.message, walletId, chainId },
        'Failed to load target wallet address'
      );
      return null;
    }

    return data.address;
  }

  /**
   * Validate funding wallet has sufficient balance
   */
  private async validateFundingBalance(
    address: string,
    requiredAmount: string | null
  ): Promise<void> {
    const balance = await this.provider.getBalance(address);
    const required = BigInt(requiredAmount || '0');

    if (balance < required) {
      throw new Error(
        `Insufficient funding balance: ${balance} < ${required} (Wei)`
      );
    }

    logger.debug(
      { address, balance: balance.toString(), required: required.toString() },
      'Funding wallet balance validated'
    );
  }

  /**
   * Get current gas price with capping
   * FIX 5c: Gas spike protection
   */
  private async getGasPrice(): Promise<bigint> {
    const feeData = await this.provider.getFeeData();
    return feeData.gasPrice || ethers.parseUnits('5', 'gwei');
  }

  /**
   * Build unsigned EVM transaction
   * FIX 5b: Nonce management and gas price handling
   */
  private async buildUnsignedTransaction(
    from: string,
    to: string,
    amount: string,
    job: GasTopupJob,
    gasPrice?: bigint
  ): Promise<ethers.TransactionRequest> {
    try {
      // Get nonce (MUST use 'pending' to handle pending transactions)
      const nonce = await this.provider.getTransactionCount(from, 'pending');

      // Use provided gas price or get new one
      if (!gasPrice) {
        gasPrice = await this.getGasPrice();
      }

      // Cap gas price
      const maxGasPrice = ethers.parseUnits(this.MAX_GAS_PRICE_GWEI.toString(), 'gwei');
      if (gasPrice > maxGasPrice) {
        gasPrice = maxGasPrice;
        logger.warn(
          {
            originalGasPrice: ethers.formatUnits(gasPrice, 'gwei'),
            cappedGasPrice: this.MAX_GAS_PRICE_GWEI,
          },
          'Gas price capped at maximum'
        );
      }

      // BSC-SPECIFIC: chainId must come from config/env (NOT hardcoded)
      // Load chain config to get chainId (numeric)
      const { data: chain } = await this.supabase
        .from('chains')
        .select('name, chain_id')
        .eq('id', job.chain_id)
        .maybeSingle();

      // Use chain_id from database if available, otherwise default based on name
      let chainId: number;
      if (chain?.chain_id) {
        chainId = parseInt(chain.chain_id.toString(), 10);
      } else {
        // Fallback: 56 = BSC Mainnet, 97 = BSC Testnet
        chainId = chain?.name === 'bsc' ? 56 : 97;
      }

      const transaction: ethers.TransactionRequest = {
        from,
        to,
        value: BigInt(amount),
        nonce,
        gasLimit: this.GAS_LIMIT,
        gasPrice,
        chainId,
      };

      logger.debug(
        {
          from,
          to,
          amount,
          nonce,
          gasPrice: ethers.formatUnits(gasPrice, 'gwei') + ' Gwei',
          chainId,
        },
        'Built unsigned BSC transaction'
      );

      return transaction;
    } catch (error: any) {
      logger.error(
        { error: error.message, from, to, amount },
        'Failed to build BSC transaction'
      );
      
      // Error classification
      this.classifyBscError(error);
      throw error;
    }
  }

  /**
   * Sign transaction via signer service
   * STEP 3: Convert unsigned EVM tx to hex before sending to signer
   */
  private async signTransaction(
    fundingWallet: OperationWalletAddress,
    unsignedTx: ethers.TransactionRequest
  ): Promise<string> {
    try {
      // STEP 3: Serialize unsigned transaction to hex
      // Use ethers to serialize the unsigned transaction to RLP-encoded hex
      const unsignedTxHex = ethers.Transaction.from({
        to: unsignedTx.to,
        value: unsignedTx.value,
        nonce: unsignedTx.nonce,
        gasLimit: unsignedTx.gasLimit,
        gasPrice: unsignedTx.gasPrice,
        chainId: unsignedTx.chainId,
      }).unsignedSerialized;

      const signedResult = await this.signerService.signTransaction({
        chain: 'bsc',
        wallet_group_id: fundingWallet.wallet_group_id,
        derivation_index: fundingWallet.derivation_index,
        unsigned_tx: unsignedTxHex, // Send as hex string
      });

      return signedResult.signed_tx;
    } catch (error: any) {
      // STEP 4: Handle signer service errors
      if (error.errorCode === 'UNAUTHORIZED' || error.errorType === 'unauthorized') {
        // Mark job failed immediately
        const err: any = new Error('Signer service unauthorized');
        err.isRetryable = false;
        err.errorType = 'unauthorized';
        throw err;
      } else if (error.errorCode === 'DERIVATION_FAILED' || error.errorType === 'derivation_failed') {
        // Mark job failed
        const err: any = new Error('Wallet derivation failed');
        err.isRetryable = false;
        err.errorType = 'derivation_failed';
        throw err;
      }
      // VAULT_UNAVAILABLE and SIGNING_FAILED are already marked as retryable by signer service
      throw error;
    }
  }

  /**
   * Broadcast signed transaction with replacement handling
   * FIX 5b: Replacement strategy hardening
   */
  private async broadcastTransactionWithReplacement(
    signedTx: string,
    job: GasTopupJob,
    originalTx: ethers.TransactionRequest
  ): Promise<string> {
    try {
      const tx = await this.provider.broadcastTransaction(signedTx);

      logger.info(
        { txHash: tx.hash, nonce: originalTx.nonce },
        'BSC transaction broadcasted successfully'
      );

      return tx.hash;
    } catch (error: any) {
      const errorMsg = error.message?.toLowerCase() || '';

      // FIX 5b: Handle replacement underpriced
      if (errorMsg.includes('replacement') && errorMsg.includes('underpriced')) {
        logger.warn(
          {
            jobId: job.id,
            currentGasPrice: originalTx.gasPrice,
          },
          'Replacement underpriced - increasing gas price'
        );

        // Bump gas price by 15%
        const currentGasPrice = BigInt(originalTx.gasPrice || 0);
        const bumpedGasPrice = (currentGasPrice * BigInt(100 + this.GAS_PRICE_BUMP_PERCENT)) / BigInt(100);

        // Check if still under cap
        const maxGasPrice = ethers.parseUnits(this.MAX_GAS_PRICE_GWEI.toString(), 'gwei');
        if (bumpedGasPrice > maxGasPrice) {
          const err: any = new Error(
            `Gas price bump exceeds cap: ${ethers.formatUnits(bumpedGasPrice, 'gwei')} > ${this.MAX_GAS_PRICE_GWEI} Gwei`
          );
          err.isRetryable = true;
          err.errorType = 'gas_price_exceeded';
          throw err;
        }

        // Retry with bumped gas price (recursive with limit)
        const newUnsignedTx = { ...originalTx, gasPrice: bumpedGasPrice };
        const fundingWallet = await this.loadOperationWalletAddress(job.operation_wallet_address_id, job.chain_id);
        if (!fundingWallet) throw new Error('Funding wallet not found');

        const newSignedTx = await this.signTransaction(fundingWallet, newUnsignedTx);
        return await this.broadcastTransactionWithReplacement(newSignedTx, job, newUnsignedTx);
      }

      // BSC-SPECIFIC: Handle 'nonce too low'
      // If error contains 'nonce too low': refetch pending nonce, rebuild, sign, broadcast
      if (errorMsg.includes('nonce too low') || errorMsg.includes('nonce') || errorMsg.includes('already known')) {
        logger.warn(
          {
            jobId: job.id,
            currentNonce: originalTx.nonce,
          },
          'Nonce too low - refetching pending nonce'
        );

        // Refetch pending nonce
        const fundingWallet = await this.loadOperationWalletAddress(job.operation_wallet_address_id, job.chain_id);
        if (!fundingWallet) throw new Error('Funding wallet not found');

        const newNonce = await this.provider.getTransactionCount(fundingWallet.address, 'pending');
        const newUnsignedTx = { ...originalTx, nonce: newNonce };
        const newSignedTx = await this.signTransaction(fundingWallet, newUnsignedTx);
        return await this.broadcastTransactionWithReplacement(newSignedTx, job, newUnsignedTx);
      }

      logger.error(
        { error: error.message, jobId: job.id },
        'Failed to broadcast BSC transaction'
      );

      this.classifyBscError(error);
      throw error;
    }
  }

  /**
   * FIX 6: ERROR CLASSIFICATION - Minimal classification for BSC
   */
  private classifyBscError(error: any): void {
    const message = error.message?.toLowerCase() || '';

    // FIX 6: Invalid address/hex/bad address → mark 'failed'
    if (
      message.includes('invalid address') ||
      message.includes('invalid hex') ||
      message.includes('bad address') ||
      message.includes('invalid') ||
      message.includes('reverted') ||
      message.includes('bad data')
    ) {
      error.isRetryable = false;
      error.errorType = 'invalid_data';
    }
    // FIX 6: Insufficient funds → mark 'failed' (rule engine must intervene)
    else if (message.includes('insufficient funds')) {
      error.isRetryable = false;
      error.errorType = 'insufficient_balance';
    }
    // FIX 6: Replacement underpriced → retry with gasPrice bump (handled in broadcastTransactionWithReplacement)
    else if (message.includes('replacement underpriced')) {
      error.isRetryable = true;
      error.errorType = 'replacement_underpriced';
    }
    // FIX 6: Nonce too low → rebuild with fresh pending nonce (handled in broadcastTransactionWithReplacement)
    else if (message.includes('nonce too low')) {
      error.isRetryable = true;
      error.errorType = 'nonce_too_low';
    }
    // Retryable errors (network, timeout, etc.)
    else if (
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('nonce') ||
      message.includes('gas')
    ) {
      error.isRetryable = true;
      error.errorType = message.includes('nonce') ? 'nonce_error' :
                        message.includes('gas') ? 'gas_error' : 'network_error';
    }
    // Otherwise → retry using existing retry_count + backoff
    else {
      error.isRetryable = true;
      error.errorType = 'unknown';
    }
  }

  /**
   * Confirm transaction
   * FIX 6: Confirmation loop safety
   */
  private async confirmTransaction(job: GasTopupJob): Promise<void> {
    if (!job.tx_hash) {
      throw new Error('Cannot confirm - no tx_hash');
    }

    try {
      // Get transaction receipt
      const receipt = await this.provider.getTransactionReceipt(job.tx_hash);

      if (!receipt) {
        logger.debug(
          { jobId: job.id, txHash: job.tx_hash },
          'Transaction not yet mined'
        );
        // FIX 2: CONFIRMATION HOT-LOOP - Update scheduled_at and exit
        await this.supabase
          .from('gas_topup_queue')
          .update({
            scheduled_at: new Date(Date.now() + this.CONFIRM_RETRY_DELAY_MS).toISOString(),
          })
          .eq('id', job.id);
        return; // Exit loop - will be picked up later
      }

      // Check if transaction succeeded
      if (receipt.status === 0) {
        const err: any = new Error('Transaction failed on-chain (status = 0)');
        err.isRetryable = false;
        err.errorType = 'tx_reverted';
        throw err;
      }

      // Get current block for confirmations
      const currentBlock = await this.provider.getBlockNumber();
      const confirmations = currentBlock - receipt.blockNumber + 1;

      logger.debug(
        {
          jobId: job.id,
          txHash: job.tx_hash,
          txBlock: receipt.blockNumber,
          currentBlock,
          confirmations,
          required: this.CONFIRMATION_BLOCKS,
        },
        'Checking BSC transaction confirmations'
      );

      if (confirmations >= this.CONFIRMATION_BLOCKS) {
        // FIX 2: On success: status='confirmed', processed_at=now()
        // FIX 1: Only update valid columns: status, processed_at
        await this.supabase
          .from('gas_topup_queue')
          .update({
            status: 'confirmed',
            processed_at: new Date().toISOString(),
          })
          .eq('id', job.id);

        // Update wallet_balances: needs_gas=false, processing_status='idle', release gas lock
        await this.releaseGasLock(job.wallet_id, job.gas_asset_id, job.chain_id, true);

        // Write audit record
        await this.writeAuditRecord(job, receipt);

        logger.info(
          {
            jobId: job.id,
            txHash: job.tx_hash,
            confirmations,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice: receipt.gasPrice.toString(),
            fundingWallet: job.operation_wallet_address_id,
          },
          '✅ BSC gas top-up confirmed'
        );
      } else {
        logger.debug(
          {
            jobId: job.id,
            confirmations,
            remaining: this.CONFIRMATION_BLOCKS - confirmations,
          },
          'Waiting for more confirmations'
        );
      }
    } catch (error: any) {
      logger.error(
        {
          error: error.message,
          jobId: job.id,
          txHash: job.tx_hash,
        },
        'Error confirming BSC transaction'
      );

      this.classifyBscError(error);
      throw error;
    }
  }


  /**
   * Write audit record
   */
  private async writeAuditRecord(
    job: GasTopupJob,
    receipt: ethers.TransactionReceipt
  ): Promise<void> {
    try {
      const fundingWallet = await this.loadOperationWalletAddress(
        job.operation_wallet_address_id
      );
      const targetAddress = await this.loadTargetWalletAddress(
        job.wallet_id,
        job.chain_id
      );

      const auditRecord = {
        job_id: job.id,
        job_type: 'gas_topup',
        chain_id: job.chain_id,
        from_address: fundingWallet?.address,
        to_address: targetAddress,
        asset_id: job.gas_asset_id,
        amount_raw: job.topup_amount_raw,
        amount_human: job.topup_amount_human,
        tx_hash: job.tx_hash,
        network_fee: receipt.gasUsed * receipt.gasPrice,
        status: 'confirmed',
        retry_count: job.retry_count,
      };

      logger.debug({ auditRecord }, 'Audit record prepared');
      // Insert would go to ledger/audit table when implemented
    } catch (error: any) {
      logger.error(
        { error: error.message, jobId: job.id },
        'Error writing audit record'
      );
    }
  }

  // FIX 5: BSC TRANSITION HELPERS - Removed transitionTo() and updateJobTxHash()
  // All status updates are now inlined to only update valid columns

  /**
   * Handle job error with retry backoff policy
   * G) RETRY / BACKOFF
   * - MAX_RETRIES=8
   * - Backoff = min(2^retry_count * 30 seconds, 15 minutes)
   * - On retryable error: increment retry_count, set error_message, scheduled_at, status='pending', release gas lock
   * - If retry_count >= MAX_RETRIES: status='failed', processed_at=now(), release gas lock
   */
  private async handleJobError(job: GasTopupJob, error: any): Promise<void> {
    const retryCount = (job.retry_count || 0) + 1;
    const maxRetries = this.MAX_RETRIES;

    // Use error classification
    const isRetryable = error.isRetryable !== false && retryCount < maxRetries;
    const errorType = error.errorType || 'unknown';

    // Calculate backoff: min(2^retry_count * 30s, 15min)
    const baseBackoffMs = 30000; // 30 seconds
    const maxBackoffMs = 15 * 60 * 1000; // 15 minutes
    const backoffMs = Math.min(
      Math.pow(2, retryCount) * baseBackoffMs,
      maxBackoffMs
    );
    const scheduledAt = new Date(Date.now() + backoffMs).toISOString();

    logger.error(
      {
        jobId: job.id,
        error: error.message,
        errorType,
        retryCount,
        maxRetries,
        isRetryable,
        nextRetryIn: `${Math.round(backoffMs / 1000)}s`,
      },
      'BSC gas top-up job error'
    );

    // FIX 1: Only update valid columns: retry_count, error_message, status, scheduled_at, processed_at
    const updates: any = {
      retry_count: retryCount,
      error_message: `[${errorType}] ${error.message}`,
    };

    if (isRetryable) {
      // On retryable error: status='pending', scheduled_at set
      updates.status = 'pending';
      updates.scheduled_at = scheduledAt;
    } else {
      // If retry_count >= MAX_RETRIES: status='failed', processed_at=now()
      updates.status = 'failed';
      updates.processed_at = new Date().toISOString();
    }

    await this.supabase
      .from('gas_topup_queue')
      .update(updates)
      .eq('id', job.id);

    // Gas lock is released in outer finally block
  }

  /**
   * Start worker loop
   */
  async start(): Promise<void> {
    if (this.isRunning || !this.runtime) {
      if (!this.runtime) logger.warn('Worker not initialized');
      else if (this.isRunning) logger.warn('BSC Gas Top-Up Worker already running');
      return;
    }

    this.isRunning = true;
    this.stopHeartbeat = this.runtime.startHeartbeat(
      defaultHeartbeatIntervalMs()
    );
    logger.info({ workerId: this.WORKER_ID }, 'Starting BSC Gas Top-Up Worker loop');

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
          'Error in BSC gas top-up worker loop'
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
   * Stop worker
   */
  stop(): void {
    logger.info({ workerId: this.WORKER_ID }, 'Stopping BSC Gas Top-Up Worker');
    this.isRunning = false;
  }

  /**
   * Graceful shutdown: stop loop and update worker_status to stopped.
   * Call from signal handler before process.exit() so DB reflects stopped state.
   */
  async shutdown(): Promise<void> {
    this.stop();
    if (this.runtime) await this.runtime.setStopped();
  }
}


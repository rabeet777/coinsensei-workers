import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../config/supabase.js';
import { SignerService } from '../../services/signer.service.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import { WorkerRuntime, workerIdentity, defaultHeartbeatIntervalMs, } from '../../control-plane/worker-runtime.js';
export class BscWithdrawalWorker {
    supabase;
    signerService;
    runtime = null;
    isRunning = false;
    stopHeartbeat = null;
    POLL_INTERVAL_MS = 10000; // 10 seconds
    MAX_RETRIES = 8;
    chainId = '';
    chainConfig = null;
    constructor() {
        this.supabase = getSupabaseClient();
        this.signerService = new SignerService('bsc-withdrawal-worker');
    }
    get WORKER_ID() {
        return this.runtime?.workerId ?? `bsc_withdrawal_${process.pid}`;
    }
    /**
     * Initialize worker - load BSC chain configuration
     */
    async initialize() {
        logger.info('Initializing BSC Withdrawal Worker...');
        const { data: chain, error } = await this.supabase
            .from('chains')
            .select('id, name, rpc_url, native_currency_decimals, chain_id_number')
            .eq('name', 'bsc')
            .eq('is_active', true)
            .maybeSingle();
        if (error || !chain) {
            throw new Error(`Failed to load BSC chain config: ${error?.message}`);
        }
        this.chainId = chain.id;
        this.chainConfig = chain;
        this.runtime = new WorkerRuntime(workerIdentity('withdrawal_execute', this.chainId));
        await this.runtime.register();
        const signerHealthy = await this.signerService.healthCheck();
        if (!signerHealthy) {
            logger.warn('Signer service health check failed - withdrawals may fail');
        }
        logger.info({
            workerId: this.WORKER_ID,
            chainId: this.chainId,
            chainName: chain.name,
            rpcUrl: chain.rpc_url,
            maxRetries: this.MAX_RETRIES,
            signerHealthy,
        }, 'BSC Withdrawal Worker initialized successfully');
    }
    /**
     * Main processing loop
     */
    async processBatch() {
        try {
            const job = await this.pickNextJob();
            if (!job) {
                return;
            }
            logger.info({
                jobId: job.id,
                withdrawalRequestId: job.withdrawal_request_id,
                toAddress: job.to_address,
                amount: job.amount_human,
                priority: job.priority,
                retryCount: job.retry_count,
            }, 'Processing BSC withdrawal job');
            await this.processJob(job);
        }
        catch (error) {
            logger.error({ error: error.message }, 'Error in BSC withdrawal batch processing');
        }
    }
    /**
     * Pick next pending job for BSC chain
     */
    async pickNextJob() {
        try {
            const { data: candidates, error } = await this.supabase
                .from('withdrawal_queue')
                .select('*')
                .eq('chain_id', this.chainId)
                .eq('status', 'pending')
                .lte('scheduled_at', new Date().toISOString())
                .lt('retry_count', this.MAX_RETRIES)
                .limit(25);
            if (error) {
                logger.error({ error: error.message }, 'Failed to fetch candidate jobs');
                return null;
            }
            if (!candidates || candidates.length === 0) {
                return null;
            }
            // Sort by priority and scheduled_at
            const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
            const priorityRank = (priority) => {
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
            return candidates[0];
        }
        catch (error) {
            logger.error({ error: error.message }, 'Error picking withdrawal job');
            return null;
        }
    }
    /**
     * Process a single withdrawal job
     */
    async processJob(job) {
        let balanceLocked = false;
        try {
            // 1. Mark job as processing
            await this.updateJobStatus(job.id, 'processing');
            // 2. Load hot wallet (sender)
            const hotWallet = await this.loadHotWallet(job.operation_wallet_address_id);
            if (!hotWallet) {
                throw new Error('Hot wallet not found');
            }
            // 3. Load asset configuration
            const asset = await this.loadAsset(job.asset_on_chain_id);
            if (!asset) {
                throw new Error('Asset configuration not found');
            }
            // 4. Lock hot wallet balance
            balanceLocked = await this.lockHotWalletBalance(hotWallet.id, job.asset_on_chain_id);
            if (!balanceLocked) {
                logger.warn({ jobId: job.id, walletId: hotWallet.id }, 'Could not lock hot wallet balance - another process may be using it');
                // Revert to pending for retry
                await this.updateJobStatus(job.id, 'pending');
                return;
            }
            logger.info({
                jobId: job.id,
                hotWallet: hotWallet.address,
                toAddress: job.to_address,
                amount: job.amount_human,
                assetType: asset.is_native ? 'Native BNB' : 'BEP20 Token',
                contractAddress: asset.contract_address || 'N/A',
            }, 'Executing BSC withdrawal');
            // 5. Build transaction intent
            const txIntent = this.buildTransactionIntent(hotWallet.address, job.to_address, job.amount_raw, asset);
            // 6. Call signer service (build, sign, broadcast)
            logger.debug({
                jobId: job.id,
                txType: txIntent.type,
                contractAddress: txIntent.contractAddress || 'N/A',
            }, 'Requesting transaction from signer service');
            const signerResult = await this.signerService.signTransaction({
                chain: 'bsc',
                wallet_group_id: hotWallet.wallet_group_id,
                derivation_index: hotWallet.derivation_index,
                tx_intent: txIntent,
            });
            const txHash = signerResult.tx_hash ||
                signerResult.txHash ||
                signerResult.transactionHash;
            if (!txHash) {
                logger.error({ jobId: job.id, signerResponse: signerResult }, 'Signer service did not return txHash');
                throw new Error('Signer service did not return txHash');
            }
            logger.info({ jobId: job.id, txHash }, 'Withdrawal transaction broadcasted successfully');
            // 7. Update job with tx_hash and move to confirming
            await this.supabase
                .from('withdrawal_queue')
                .update({
                status: 'confirming',
                tx_hash: txHash,
                processed_at: new Date().toISOString(),
            })
                .eq('id', job.id);
            // Note: Balance lock remains until confirmation worker confirms the transaction
        }
        catch (error) {
            // Release balance lock on error
            if (balanceLocked) {
                await this.releaseBalanceLock(job.operation_wallet_address_id, job.asset_on_chain_id);
            }
            await this.handleJobError(job, error);
        }
    }
    /**
     * Load hot wallet (operation wallet)
     */
    async loadHotWallet(id) {
        const { data, error } = await this.supabase
            .from('operation_wallet_addresses')
            .select('*')
            .eq('id', id)
            .eq('is_active', true)
            .maybeSingle();
        if (error) {
            logger.error({ error: error.message, id }, 'Error loading hot wallet');
            throw error;
        }
        return data;
    }
    /**
     * Load asset configuration
     */
    async loadAsset(id) {
        const { data, error } = await this.supabase
            .from('asset_on_chain')
            .select('*')
            .eq('id', id)
            .eq('is_active', true)
            .maybeSingle();
        if (error) {
            logger.error({ error: error.message, id }, 'Error loading asset');
            throw error;
        }
        return data;
    }
    /**
     * Lock hot wallet balance during withdrawal processing
     */
    async lockHotWalletBalance(walletId, assetOnChainId) {
        try {
            const { data, error } = await this.supabase
                .from('wallet_balances')
                .update({
                processing_status: 'withdrawing', // VARCHAR(20) limit - shortened from 'withdrawal_processing'
            })
                .eq('wallet_id', walletId)
                .eq('asset_on_chain_id', assetOnChainId)
                .eq('processing_status', 'idle')
                .select();
            if (error) {
                logger.error({ error: error.message, walletId }, 'Failed to lock hot wallet balance');
                return false;
            }
            if (!data || data.length === 0) {
                logger.debug({ walletId, assetOnChainId }, 'Balance lock not acquired - wallet may be processing');
                return false;
            }
            logger.debug({ walletId }, 'Hot wallet balance locked');
            return true;
        }
        catch (error) {
            logger.error({ error: error.message, walletId }, 'Error acquiring balance lock');
            return false;
        }
    }
    /**
     * Release hot wallet balance lock
     */
    async releaseBalanceLock(walletId, assetOnChainId) {
        try {
            await this.supabase
                .from('wallet_balances')
                .update({
                processing_status: 'idle',
                last_processed_at: new Date().toISOString(),
            })
                .eq('wallet_id', walletId)
                .eq('asset_on_chain_id', assetOnChainId);
            logger.debug({ walletId }, 'Released hot wallet balance lock');
        }
        catch (error) {
            logger.error({ error: error.message, walletId }, 'Error releasing balance lock');
        }
    }
    /**
     * Build transaction intent (native BNB or BEP20 token)
     */
    buildTransactionIntent(from, to, amountRaw, asset) {
        if (asset.is_native) {
            // Native BNB transfer
            return {
                type: 'native_transfer',
                from,
                to,
                value: amountRaw,
                gasLimit: 21000, // Standard ETH transfer gas limit
            };
        }
        else {
            // BEP20 token transfer
            if (!asset.contract_address) {
                throw new Error('Token contract address is required for BEP20 withdrawal');
            }
            return {
                type: 'erc20_transfer',
                from,
                to,
                contractAddress: asset.contract_address,
                amount: amountRaw,
                gasLimit: 65000, // Standard ERC20 transfer gas limit
            };
        }
    }
    /**
     * Update job status
     */
    async updateJobStatus(jobId, status) {
        await this.supabase
            .from('withdrawal_queue')
            .update({ status })
            .eq('id', jobId);
    }
    /**
     * Handle job error
     */
    async handleJobError(job, error) {
        const retryCount = job.retry_count + 1;
        const maxRetries = job.max_retries || this.MAX_RETRIES;
        const isRetryable = error.isRetryable !== false && retryCount < maxRetries;
        const errorType = error.errorType || 'unknown';
        const baseBackoffMs = 30000; // 30 seconds
        const maxBackoffMs = 15 * 60 * 1000; // 15 minutes
        const backoffMs = Math.min(Math.pow(2, retryCount) * baseBackoffMs, maxBackoffMs);
        const scheduledAt = new Date(Date.now() + backoffMs).toISOString();
        logger.error({
            jobId: job.id,
            error: error.message,
            errorType,
            retryCount,
            maxRetries,
            isRetryable,
            nextRetryIn: `${Math.round(backoffMs / 1000)}s`,
        }, 'BSC withdrawal job error');
        const updates = {
            retry_count: retryCount,
            error_message: `[${errorType}] ${error.message}`,
        };
        if (isRetryable) {
            updates.status = 'pending';
            updates.scheduled_at = scheduledAt;
        }
        else {
            updates.status = 'failed';
            updates.processed_at = new Date().toISOString();
        }
        await this.supabase.from('withdrawal_queue').update(updates).eq('id', job.id);
    }
    /**
     * Start the worker loop
     */
    async start() {
        if (this.isRunning || !this.runtime) {
            if (!this.runtime)
                logger.warn('Worker not initialized');
            else if (this.isRunning)
                logger.warn('BSC Withdrawal Worker already running');
            return;
        }
        this.isRunning = true;
        this.stopHeartbeat = this.runtime.startHeartbeat(defaultHeartbeatIntervalMs());
        logger.info({ workerId: this.WORKER_ID }, 'Starting BSC Withdrawal Worker loop');
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
                await this.processBatch();
                await this.runtime.logExecution({
                    executionType: 'cycle',
                    status: 'success',
                    durationMs: Date.now() - cycleStart,
                });
            }
            catch (error) {
                logger.error({ error: error.message }, 'Error in BSC withdrawal worker loop');
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
    stop() {
        logger.info({ workerId: this.WORKER_ID }, 'Stopping BSC Withdrawal Worker');
        this.isRunning = false;
    }
}
//# sourceMappingURL=bsc-withdrawal.worker.js.map
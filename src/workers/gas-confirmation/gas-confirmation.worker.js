import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import { WorkerRuntime, workerIdentity, defaultHeartbeatIntervalMs, } from '../../control-plane/worker-runtime.js';
export class GasConfirmationWorker {
    supabase;
    runtime;
    isRunning = false;
    stopHeartbeat = null;
    POLL_INTERVAL_MS = 10000; // 10 seconds
    BATCH_SIZE = 10; // Process up to 10 jobs per batch
    chains = new Map();
    tronClients = new Map();
    bscClients = new Map();
    constructor() {
        this.supabase = getSupabaseClient();
        this.runtime = new WorkerRuntime(workerIdentity('gas_topup_confirmation', null));
    }
    /**
     * Initialize worker - load chain configurations
     */
    async initialize() {
        logger.info('Initializing Gas Confirmation Worker...');
        await this.runtime.register();
        // Load all active chains
        const { data: chains, error } = await this.supabase
            .from('chains')
            .select('*')
            .eq('is_active', true);
        if (error) {
            throw new Error(`Failed to load chain configs: ${error.message}`);
        }
        if (!chains || chains.length === 0) {
            throw new Error('No active chains found');
        }
        // Store chain configs and initialize blockchain clients
        for (const chain of chains) {
            this.chains.set(chain.id, {
                id: chain.id,
                name: chain.name,
                rpc_url: chain.rpc_url,
                confirmation_threshold: chain.confirmation_threshold || 1,
            });
            // Initialize blockchain clients based on chain type
            if (chain.name.toLowerCase() === 'tron') {
                const { TronWeb } = await import('tronweb');
                this.tronClients.set(chain.id, new TronWeb({ fullHost: chain.rpc_url }));
            }
            else if (chain.name.toLowerCase() === 'bsc' || chain.name.toLowerCase().includes('bsc')) {
                const { ethers } = await import('ethers');
                this.bscClients.set(chain.id, new ethers.JsonRpcProvider(chain.rpc_url));
            }
        }
        logger.info({
            workerId: this.runtime.workerId,
            chainCount: this.chains.size,
            chains: Array.from(this.chains.values()).map(c => ({
                name: c.name,
                confirmations: c.confirmation_threshold,
            })),
        }, 'Gas Confirmation Worker initialized successfully');
    }
    /**
     * Process a batch of confirming jobs
     */
    async processBatch() {
        try {
            // Pick jobs with status='confirming' and tx_hash IS NOT NULL
            const jobs = await this.pickConfirmingJobs();
            if (!jobs || jobs.length === 0) {
                // Only log debug occasionally to avoid spam
                if (Math.random() < 0.1) {
                    logger.debug('No gas top-up jobs to confirm');
                }
                return;
            }
            logger.info({ jobCount: jobs.length, workerId: this.runtime.workerId }, 'Processing gas confirmation batch');
            // Process each job
            for (const job of jobs) {
                try {
                    await this.confirmJob(job);
                }
                catch (error) {
                    logger.error({ error: error.message, jobId: job.id, txHash: job.tx_hash }, 'Error confirming job');
                    // Continue with next job
                }
            }
        }
        catch (error) {
            logger.error({ error: error.message }, 'Error processing confirmation batch');
        }
    }
    /**
     * Pick jobs that need confirmation
     * Select jobs where status='confirming' and tx_hash IS NOT NULL
     */
    async pickConfirmingJobs() {
        try {
            const { data: jobs, error } = await this.supabase
                .from('gas_topup_queue')
                .select('*')
                .eq('status', 'confirming')
                .not('tx_hash', 'is', null)
                .limit(this.BATCH_SIZE);
            if (error) {
                logger.error({ error: error.message }, 'Failed to fetch confirming jobs');
                return [];
            }
            return (jobs || []);
        }
        catch (error) {
            logger.error({ error: error.message }, 'Error picking confirming jobs');
            return [];
        }
    }
    /**
     * Confirm a single job by checking on-chain status
     */
    async confirmJob(job) {
        if (!job.tx_hash) {
            logger.warn({ jobId: job.id }, 'Job has no tx_hash - skipping');
            return;
        }
        // Load chain config
        const chainConfig = this.chains.get(job.chain_id);
        if (!chainConfig) {
            logger.error({ jobId: job.id, chainId: job.chain_id }, 'Chain config not found');
            return;
        }
        logger.debug({
            jobId: job.id,
            txHash: job.tx_hash,
            chain: chainConfig.name,
            confirmationsRequired: chainConfig.confirmation_threshold,
        }, 'Confirming gas top-up transaction');
        // Confirm transaction based on chain type
        if (chainConfig.name.toLowerCase() === 'tron') {
            await this.confirmTronTransaction(job, chainConfig);
        }
        else if (chainConfig.name.toLowerCase() === 'bsc' || chainConfig.name.toLowerCase().includes('bsc')) {
            await this.confirmBscTransaction(job, chainConfig);
        }
        else {
            logger.warn({ jobId: job.id, chain: chainConfig.name }, 'Unsupported chain type for confirmation');
        }
    }
    /**
     * Confirm TRON transaction
     */
    async confirmTronTransaction(job, chainConfig) {
        try {
            const tronWeb = this.tronClients.get(chainConfig.id);
            if (!tronWeb) {
                logger.error({ jobId: job.id }, 'TRON client not initialized');
                return;
            }
            // Get transaction info
            const txInfo = await tronWeb.trx.getTransactionInfo(job.tx_hash);
            // A) Transaction not found or no blockNumber
            if (!txInfo || !txInfo.blockNumber) {
                logger.debug({ jobId: job.id, txHash: job.tx_hash }, 'Transaction not yet mined - leaving in confirming state');
                return;
            }
            // Get current block
            const currentBlock = await tronWeb.trx.getCurrentBlock();
            const currentBlockNumber = currentBlock.block_header.raw_data.number;
            // C) Check confirmations
            const confirmations = currentBlockNumber - txInfo.blockNumber + 1;
            logger.debug({
                jobId: job.id,
                txHash: job.tx_hash,
                txBlock: txInfo.blockNumber,
                currentBlock: currentBlockNumber,
                confirmations,
                required: chainConfig.confirmation_threshold,
            }, 'TRON transaction confirmation status');
            if (confirmations < chainConfig.confirmation_threshold) {
                logger.debug({
                    jobId: job.id,
                    confirmations,
                    remaining: chainConfig.confirmation_threshold - confirmations,
                }, 'Waiting for more confirmations');
                return;
            }
            // D) Transaction confirmed - check execution result
            // For TRON native TRX transfers, receipt.result is often undefined (implicit SUCCESS)
            // Only contract calls or failed transactions have explicit result codes
            let isSuccess = false;
            let errorMessage = '';
            if (txInfo.receipt) {
                const receiptResult = txInfo.receipt.result;
                // TRON receipt.result can be:
                // - undefined/missing: SUCCESS (default for successful native TRX transfers)
                // - 'SUCCESS': Explicit success
                // - 'REVERT': Contract execution failed
                // - 'OUT_OF_ENERGY': Insufficient energy
                // - 'OUT_OF_TIME': Execution timeout
                if (!receiptResult || receiptResult === 'SUCCESS') {
                    isSuccess = true;
                }
                else {
                    isSuccess = false;
                    errorMessage = `Transaction failed on-chain: ${receiptResult}`;
                }
                logger.debug({
                    jobId: job.id,
                    txHash: job.tx_hash,
                    receiptResult: receiptResult || 'IMPLICIT_SUCCESS',
                    fullReceipt: txInfo.receipt,
                    isSuccess,
                }, 'TRON transaction receipt details');
            }
            else {
                // No receipt but transaction is mined and confirmed
                // For native TRX transfers, this typically means success
                logger.debug({
                    jobId: job.id,
                    txHash: job.tx_hash,
                    txInfo: {
                        blockNumber: txInfo.blockNumber,
                        fee: txInfo.fee,
                    },
                }, 'TRON transaction has no receipt - treating as success for native transfer');
                isSuccess = true;
            }
            if (isSuccess) {
                logger.info({
                    jobId: job.id,
                    txHash: job.tx_hash,
                    confirmations,
                    blockNumber: txInfo.blockNumber,
                    fee: txInfo.fee,
                }, '✅ TRON gas top-up transaction confirmed successfully');
                await this.finalizeSuccess(job, chainConfig, confirmations);
            }
            else {
                logger.error({
                    jobId: job.id,
                    txHash: job.tx_hash,
                    receipt: txInfo.receipt,
                    txInfo: {
                        blockNumber: txInfo.blockNumber,
                        fee: txInfo.fee,
                        energyUsage: txInfo.receipt?.energy_usage_total,
                        netUsage: txInfo.receipt?.net_usage,
                    },
                }, '❌ TRON gas top-up transaction failed on-chain');
                await this.finalizeFailure(job, chainConfig, errorMessage);
            }
        }
        catch (error) {
            logger.error({ error: error.message, jobId: job.id, txHash: job.tx_hash }, 'Error confirming TRON transaction');
            // Do not update job - leave in confirming state for retry
        }
    }
    /**
     * Confirm BSC transaction
     */
    async confirmBscTransaction(job, chainConfig) {
        try {
            const provider = this.bscClients.get(chainConfig.id);
            if (!provider) {
                logger.error({ jobId: job.id }, 'BSC provider not initialized');
                return;
            }
            // Get transaction receipt
            const receipt = await provider.getTransactionReceipt(job.tx_hash);
            // A) Transaction not found or not mined
            if (!receipt || !receipt.blockNumber) {
                logger.debug({ jobId: job.id, txHash: job.tx_hash }, 'Transaction not yet mined - leaving in confirming state');
                return;
            }
            // Get current block number
            const currentBlockNumber = await provider.getBlockNumber();
            // C) Check confirmations
            const confirmations = currentBlockNumber - receipt.blockNumber + 1;
            logger.debug({
                jobId: job.id,
                txHash: job.tx_hash,
                txBlock: receipt.blockNumber,
                currentBlock: currentBlockNumber,
                confirmations,
                required: chainConfig.confirmation_threshold,
            }, 'BSC transaction confirmation status');
            if (confirmations < chainConfig.confirmation_threshold) {
                logger.debug({
                    jobId: job.id,
                    confirmations,
                    remaining: chainConfig.confirmation_threshold - confirmations,
                }, 'Waiting for more confirmations');
                return;
            }
            // D) Transaction confirmed - check execution result
            const isSuccess = receipt.status === 1;
            if (isSuccess) {
                await this.finalizeSuccess(job, chainConfig, confirmations);
            }
            else {
                const errorMessage = 'Transaction failed on-chain (status=0)';
                await this.finalizeFailure(job, chainConfig, errorMessage);
            }
        }
        catch (error) {
            logger.error({ error: error.message, jobId: job.id, txHash: job.tx_hash }, 'Error confirming BSC transaction');
            // Do not update job - leave in confirming state for retry
        }
    }
    /**
     * Finalize successful transaction (ATOMIC)
     */
    async finalizeSuccess(job, chainConfig, confirmations) {
        try {
            logger.info({
                jobId: job.id,
                txHash: job.tx_hash,
                chain: chainConfig.name,
                confirmations,
            }, '✅ Gas top-up transaction confirmed successfully');
            // 1) Update gas_topup_queue: status='confirmed', processed_at=now(), reset retry_count
            const { error: queueError } = await this.supabase
                .from('gas_topup_queue')
                .update({
                status: 'confirmed',
                processed_at: new Date().toISOString(),
                retry_count: 0,
                error_message: null,
            })
                .eq('id', job.id);
            if (queueError) {
                logger.error({ error: queueError.message, jobId: job.id }, 'Failed to update gas_topup_queue status to confirmed');
                return;
            }
            // 2) Update wallet_balances: needs_gas=false, release gas lock, processing_status='idle'
            await this.releaseGasLock(job, true);
            logger.info({
                jobId: job.id,
                walletId: job.wallet_id,
                txHash: job.tx_hash,
                retryCount: job.retry_count || 0,
            }, 'Gas top-up finalized successfully');
        }
        catch (error) {
            logger.error({ error: error.message, jobId: job.id }, 'Error finalizing success');
        }
    }
    /**
     * Finalize failed transaction (ATOMIC)
     */
    async finalizeFailure(job, chainConfig, errorMessage) {
        try {
            logger.error({
                jobId: job.id,
                txHash: job.tx_hash,
                chain: chainConfig.name,
                errorMessage,
            }, '❌ Gas top-up transaction failed on-chain');
            // 1) Update gas_topup_queue: status='failed', processed_at=now(), error_message
            const { error: queueError } = await this.supabase
                .from('gas_topup_queue')
                .update({
                status: 'failed',
                processed_at: new Date().toISOString(),
                error_message: errorMessage,
            })
                .eq('id', job.id);
            if (queueError) {
                logger.error({ error: queueError.message, jobId: job.id }, 'Failed to update gas_topup_queue status to failed');
                return;
            }
            // 2) Update wallet_balances: release gas lock, processing_status='idle'
            await this.releaseGasLock(job, false);
            logger.info({
                jobId: job.id,
                walletId: job.wallet_id,
                txHash: job.tx_hash,
            }, 'Failed gas top-up finalized');
        }
        catch (error) {
            logger.error({ error: error.message, jobId: job.id }, 'Error finalizing failure');
        }
    }
    /**
     * Release gas lock at wallet_balances level
     */
    async releaseGasLock(job, success) {
        try {
            // Resolve asset_on_chain_id for native gas asset
            const { data: gasAssetOnChain } = await this.supabase
                .from('asset_on_chain')
                .select('id')
                .eq('chain_id', job.chain_id)
                .eq('asset_id', job.gas_asset_id)
                .maybeSingle();
            if (!gasAssetOnChain) {
                logger.warn({ jobId: job.id, gasAssetId: job.gas_asset_id, chainId: job.chain_id }, 'Could not resolve asset_on_chain_id for gas lock release');
                return;
            }
            const updates = {
                gas_locked_until: null,
                gas_locked_by: null,
                processing_status: 'idle',
                last_processed_at: new Date().toISOString(),
            };
            // On success, mark wallet as no longer needing gas
            if (success) {
                updates.needs_gas = false;
            }
            const { error } = await this.supabase
                .from('wallet_balances')
                .update(updates)
                .eq('wallet_id', job.wallet_id)
                .eq('asset_on_chain_id', gasAssetOnChain.id);
            if (error) {
                logger.error({ error: error.message, jobId: job.id, walletId: job.wallet_id }, 'Failed to release gas lock');
            }
            else {
                logger.debug({ jobId: job.id, walletId: job.wallet_id, success }, 'Released gas lock and updated wallet state');
            }
        }
        catch (error) {
            logger.error({ error: error.message, jobId: job.id }, 'Error releasing gas lock');
        }
    }
    /**
     * Start worker loop
     */
    async start() {
        if (this.isRunning) {
            logger.warn('Gas Confirmation Worker already running');
            return;
        }
        this.isRunning = true;
        this.stopHeartbeat = this.runtime.startHeartbeat(defaultHeartbeatIntervalMs());
        logger.info({ workerId: this.runtime.workerId }, 'Starting Gas Confirmation Worker loop');
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
                logger.error({ error: error.message }, 'Error in gas confirmation worker loop');
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
    stop() {
        logger.info({ workerId: this.runtime.workerId }, 'Stopping Gas Confirmation Worker');
        this.isRunning = false;
    }
}
//# sourceMappingURL=gas-confirmation.worker.js.map
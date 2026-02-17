import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import { ethers } from 'ethers';
import { WorkerRuntime, workerIdentity, defaultHeartbeatIntervalMs, } from '../../control-plane/worker-runtime.js';
let TronWeb;
export class WithdrawalConfirmationWorker {
    supabase;
    runtime;
    isRunning = false;
    stopHeartbeat = null;
    BATCH_SIZE = 10;
    chains = new Map();
    tronClients = new Map();
    evmClients = new Map();
    defaultPollInterval = 10000; // 10 seconds default
    constructor() {
        this.supabase = getSupabaseClient();
        this.runtime = new WorkerRuntime(workerIdentity('withdrawal_confirmation', null));
    }
    /**
     * Initialize worker - load chain configurations and create RPC clients
     */
    async initialize() {
        logger.info('Initializing Withdrawal Confirmation Worker...');
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
            const chainType = chain.name.toLowerCase().includes('tron') ? 'tron' : 'evm';
            this.chains.set(chain.id, {
                id: chain.id,
                name: chain.name,
                rpc_url: chain.rpc_url,
                confirmation_threshold: chain.confirmation_threshold || 1,
                block_time_seconds: chain.block_time_seconds || 3,
            });
            // Initialize blockchain clients based on chain type
            if (chainType === 'tron') {
                const { TronWeb: TronWebImport } = await import('tronweb');
                TronWeb = TronWebImport;
                this.tronClients.set(chain.id, new TronWeb({ fullHost: chain.rpc_url }));
            }
            else {
                this.evmClients.set(chain.id, new ethers.JsonRpcProvider(chain.rpc_url));
            }
        }
        // Calculate average block time for idle sleep
        const blockTimes = Array.from(this.chains.values()).map((c) => c.block_time_seconds);
        this.defaultPollInterval = (blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length) * 1000;
        logger.info({
            workerId: this.runtime.workerId,
            chainCount: this.chains.size,
            chains: Array.from(this.chains.values()).map((c) => ({
                name: c.name,
                confirmations: c.confirmation_threshold,
                blockTime: c.block_time_seconds,
            })),
            pollInterval: `${this.defaultPollInterval}ms`,
        }, 'Withdrawal Confirmation Worker initialized successfully');
    }
    /**
     * Process a batch of confirming jobs
     */
    async processBatch() {
        try {
            const jobs = await this.pickConfirmingJobs();
            if (!jobs || jobs.length === 0) {
                // Only log occasionally to avoid spam
                if (Math.random() < 0.1) {
                    logger.debug('No withdrawal jobs to confirm');
                }
                return;
            }
            logger.info({ jobCount: jobs.length, workerId: this.runtime.workerId }, 'Processing withdrawal confirmation batch');
            for (const job of jobs) {
                const chainConfig = this.chains.get(job.chain_id);
                if (!chainConfig) {
                    logger.error({ jobId: job.id, chainId: job.chain_id }, 'Chain configuration not found for job');
                    continue;
                }
                await this.processJob(job, chainConfig);
            }
        }
        catch (error) {
            logger.error({ error: error.message, workerId: this.runtime.workerId }, 'Error in Withdrawal Confirmation Worker batch processing');
        }
    }
    /**
     * Pick jobs with status='confirming' and tx_hash IS NOT NULL
     */
    async pickConfirmingJobs() {
        const { data: jobs, error } = await this.supabase
            .from('withdrawal_queue')
            .select('*')
            .eq('status', 'confirming')
            .not('tx_hash', 'is', null)
            .order('processed_at', { ascending: true })
            .limit(this.BATCH_SIZE);
        if (error) {
            logger.error({ error: error.message }, 'Failed to fetch jobs for confirmation');
            return [];
        }
        return jobs || [];
    }
    /**
     * Process a single job for confirmation
     */
    async processJob(job, chainConfig) {
        logger.debug({
            jobId: job.id,
            withdrawalRequestId: job.withdrawal_request_id,
            chain: chainConfig.name,
            txHash: job.tx_hash,
            confirmationsRequired: chainConfig.confirmation_threshold,
        }, 'Checking withdrawal transaction confirmation');
        // Determine chain type and confirm accordingly
        const chainType = chainConfig.name.toLowerCase().includes('tron') ? 'tron' : 'evm';
        if (chainType === 'tron') {
            await this.confirmTronTransaction(job, chainConfig);
        }
        else {
            await this.confirmEvmTransaction(job, chainConfig);
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
            // B) Check receipt
            if (!txInfo.receipt) {
                logger.debug({ jobId: job.id, txHash: job.tx_hash }, 'Transaction receipt not available - leaving in confirming state');
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
            }, 'TRON withdrawal transaction confirmation status');
            if (confirmations < chainConfig.confirmation_threshold) {
                logger.debug({
                    jobId: job.id,
                    confirmations,
                    remaining: chainConfig.confirmation_threshold - confirmations,
                }, 'Waiting for more confirmations');
                return;
            }
            // D) Transaction confirmed - check execution result
            const receiptResult = txInfo.receipt.result;
            let isSuccess = false;
            // TRON: undefined or 'SUCCESS' = success
            if (!receiptResult || receiptResult === 'SUCCESS') {
                isSuccess = true;
            }
            else {
                isSuccess = false;
            }
            logger.debug({
                jobId: job.id,
                txHash: job.tx_hash,
                receiptResult,
                isSuccess,
            }, 'TRON withdrawal transaction result');
            if (isSuccess) {
                await this.finalizeSuccess(job, chainConfig, confirmations, txInfo.blockNumber, txInfo.fee);
            }
            else {
                const errorMessage = `Transaction failed on-chain: ${receiptResult || 'UNKNOWN'}`;
                logger.error({
                    jobId: job.id,
                    txHash: job.tx_hash,
                    receipt: txInfo.receipt,
                }, 'Withdrawal transaction failed on-chain');
                await this.finalizeFailure(job, chainConfig, errorMessage);
            }
        }
        catch (error) {
            logger.error({ error: error.message, jobId: job.id, txHash: job.tx_hash }, 'Error confirming TRON withdrawal transaction');
            // Do not update job - leave in confirming state for retry
        }
    }
    /**
     * Confirm EVM transaction (BSC, etc.)
     */
    async confirmEvmTransaction(job, chainConfig) {
        try {
            const provider = this.evmClients.get(chainConfig.id);
            if (!provider) {
                logger.error({ jobId: job.id }, 'EVM client not initialized');
                return;
            }
            const receipt = await provider.getTransactionReceipt(job.tx_hash);
            if (!receipt) {
                logger.debug({ jobId: job.id, txHash: job.tx_hash }, 'Transaction receipt not found - leaving in confirming state');
                return; // Not yet mined
            }
            // Get current block number
            const currentBlock = await provider.getBlockNumber();
            // Calculate confirmations
            const confirmations = currentBlock - receipt.blockNumber + 1;
            logger.debug({
                jobId: job.id,
                txHash: job.tx_hash,
                txBlock: receipt.blockNumber,
                currentBlock,
                confirmations,
                required: chainConfig.confirmation_threshold,
            }, 'EVM withdrawal transaction confirmation status');
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
                const gasUsed = Number(receipt.gasUsed);
                const gasPrice = receipt.gasPrice ? Number(receipt.gasPrice) : null;
                await this.finalizeSuccess(job, chainConfig, confirmations, receipt.blockNumber, gasUsed, gasPrice);
            }
            else {
                const errorMessage = `Transaction failed on-chain (status=${receipt.status})`;
                await this.finalizeFailure(job, chainConfig, errorMessage);
            }
        }
        catch (error) {
            logger.error({ error: error.message, jobId: job.id, txHash: job.tx_hash }, 'Error confirming EVM withdrawal transaction');
            // Do not update job - leave in confirming state for retry
        }
    }
    /**
     * Finalize successful withdrawal (ATOMIC)
     */
    async finalizeSuccess(job, chainConfig, confirmations, blockNumber, gasUsed, gasPrice) {
        try {
            logger.info({
                jobId: job.id,
                withdrawalRequestId: job.withdrawal_request_id,
                txHash: job.tx_hash,
                chain: chainConfig.name,
                confirmations,
                blockNumber,
                gasUsed: gasUsed || null,
                gasPrice: gasPrice || null,
            }, '✅ Withdrawal transaction confirmed successfully');
            // 1) Update withdrawal_queue: status='confirmed', processed_at=now()
            const updateData = {
                status: 'confirmed',
                processed_at: new Date().toISOString(),
                retry_count: 0, // Reset retry counter on success
                error_message: null, // Clear any previous error messages
            };
            // Add gas data if available
            if (gasUsed !== undefined) {
                updateData.gas_used = gasUsed.toString();
            }
            if (gasPrice !== undefined && gasPrice !== null) {
                updateData.gas_price = gasPrice.toString();
            }
            const { error: queueError } = await this.supabase
                .from('withdrawal_queue')
                .update(updateData)
                .eq('id', job.id);
            if (queueError) {
                logger.error({ error: queueError.message, jobId: job.id }, 'Failed to update withdrawal_queue status to confirmed');
                return;
            }
            // 2) Update withdrawal_requests: status='completed', final_tx_hash
            const { error: requestError } = await this.supabase
                .from('withdrawal_requests')
                .update({
                status: 'completed',
                final_tx_hash: job.tx_hash,
                updated_at: new Date().toISOString(),
            })
                .eq('id', job.withdrawal_request_id);
            if (requestError) {
                logger.error({ error: requestError.message, withdrawalRequestId: job.withdrawal_request_id }, 'Failed to update withdrawal_requests status to completed');
            }
            // 3) Release hot wallet balance lock
            await this.releaseHotWalletLock(job.operation_wallet_address_id, job.asset_on_chain_id);
            logger.info({
                jobId: job.id,
                withdrawalRequestId: job.withdrawal_request_id,
                txHash: job.tx_hash,
                retryCount: job.retry_count,
            }, 'Withdrawal finalized successfully');
        }
        catch (error) {
            logger.error({ error: error.message, jobId: job.id, txHash: job.tx_hash }, 'Error finalizing successful withdrawal');
        }
    }
    /**
     * Finalize failed withdrawal (ATOMIC)
     */
    async finalizeFailure(job, chainConfig, reason) {
        try {
            logger.error({
                jobId: job.id,
                withdrawalRequestId: job.withdrawal_request_id,
                txHash: job.tx_hash,
                chain: chainConfig.name,
                errorMessage: reason,
            }, '❌ Withdrawal transaction failed on-chain');
            // 1) Update withdrawal_queue: status='failed', processed_at=now(), error_message
            const { error: queueError } = await this.supabase
                .from('withdrawal_queue')
                .update({
                status: 'failed',
                processed_at: new Date().toISOString(),
                error_message: reason,
            })
                .eq('id', job.id);
            if (queueError) {
                logger.error({ error: queueError.message, jobId: job.id }, 'Failed to update withdrawal_queue status to failed');
                return;
            }
            // 2) Update withdrawal_requests: status='failed'
            const { error: requestError } = await this.supabase
                .from('withdrawal_requests')
                .update({
                status: 'failed',
                updated_at: new Date().toISOString(),
            })
                .eq('id', job.withdrawal_request_id);
            if (requestError) {
                logger.error({ error: requestError.message, withdrawalRequestId: job.withdrawal_request_id }, 'Failed to update withdrawal_requests status to failed');
            }
            // 3) Release hot wallet balance lock
            await this.releaseHotWalletLock(job.operation_wallet_address_id, job.asset_on_chain_id);
            logger.info({
                jobId: job.id,
                withdrawalRequestId: job.withdrawal_request_id,
                txHash: job.tx_hash,
            }, 'Failed withdrawal finalized');
        }
        catch (error) {
            logger.error({ error: error.message, jobId: job.id, txHash: job.tx_hash }, 'Error finalizing failed withdrawal');
        }
    }
    /**
     * Release hot wallet balance lock
     */
    async releaseHotWalletLock(walletId, assetOnChainId) {
        try {
            await this.supabase
                .from('wallet_balances')
                .update({
                processing_status: 'idle',
                last_processed_at: new Date().toISOString(),
            })
                .eq('wallet_id', walletId)
                .eq('asset_on_chain_id', assetOnChainId);
            logger.debug({ walletId, assetOnChainId }, 'Released hot wallet balance lock');
        }
        catch (error) {
            logger.error({ error: error.message, walletId }, 'Error releasing hot wallet balance lock');
        }
    }
    /**
     * Start the worker loop
     */
    async start() {
        if (this.isRunning) {
            logger.warn('Withdrawal Confirmation Worker already running');
            return;
        }
        this.isRunning = true;
        this.stopHeartbeat = this.runtime.startHeartbeat(defaultHeartbeatIntervalMs());
        logger.info({ workerId: this.runtime.workerId }, 'Starting Withdrawal Confirmation Worker loop');
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
                    await sleep(this.defaultPollInterval);
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
                logger.error({ error: error.message }, 'Error in Withdrawal Confirmation Worker loop');
                await this.runtime.logExecution({
                    executionType: 'cycle',
                    status: 'fail',
                    durationMs: Date.now() - cycleStart,
                    errorMessage: error?.message ?? String(error),
                });
            }
            await sleep(this.defaultPollInterval);
        }
        this.stopHeartbeat?.();
        await this.runtime.setStopped();
    }
    /**
     * Stop the worker loop
     */
    stop() {
        logger.info({ workerId: this.runtime.workerId }, 'Stopping Withdrawal Confirmation Worker');
        this.isRunning = false;
    }
}
//# sourceMappingURL=withdrawal-confirmation.worker.js.map
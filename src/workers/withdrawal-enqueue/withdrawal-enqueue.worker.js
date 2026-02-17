import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import { WorkerRuntime, workerIdentity, defaultHeartbeatIntervalMs, } from '../../control-plane/worker-runtime.js';
export class WithdrawalEnqueueWorker {
    supabase;
    runtime;
    isRunning = false;
    stopHeartbeat = null;
    POLL_INTERVAL_MS = 10000; // 10 seconds
    BATCH_SIZE = 10;
    constructor() {
        this.supabase = getSupabaseClient();
        this.runtime = new WorkerRuntime(workerIdentity('withdrawal_enqueue', null));
    }
    /**
     * Initialize worker
     */
    async initialize() {
        logger.info('Initializing Withdrawal Enqueue Worker...');
        await this.runtime.register();
        // Test database connectivity
        const { error } = await this.supabase.from('chains').select('id').limit(1);
        if (error) {
            throw new Error(`Failed to connect to database: ${error.message}`);
        }
        logger.info({
            workerId: this.runtime.workerId,
            pollInterval: `${this.POLL_INTERVAL_MS}ms`,
            batchSize: this.BATCH_SIZE,
        }, 'Withdrawal Enqueue Worker initialized successfully');
    }
    /**
     * Process a batch of approved withdrawal requests
     */
    async processBatch() {
        try {
            const requests = await this.pickApprovedRequests();
            if (!requests || requests.length === 0) {
                // Only log occasionally to avoid spam
                if (Math.random() < 0.1) {
                    logger.debug('No approved withdrawal requests to enqueue');
                }
                return;
            }
            logger.info({ count: requests.length, workerId: this.runtime.workerId }, 'Processing approved withdrawal requests');
            for (const request of requests) {
                await this.processRequest(request);
            }
        }
        catch (error) {
            logger.error({ error: error.message, workerId: this.runtime.workerId }, 'Error in Withdrawal Enqueue Worker batch processing');
        }
    }
    /**
     * Pick approved withdrawal requests that haven't been queued yet
     */
    async pickApprovedRequests() {
        const { data: requests, error } = await this.supabase
            .from('withdrawal_requests')
            .select('*')
            .eq('status', 'approved')
            .is('queued_at', null)
            .order('created_at', { ascending: true })
            .limit(this.BATCH_SIZE);
        if (error) {
            logger.error({ error: error.message }, 'Failed to fetch approved withdrawal requests');
            return [];
        }
        return requests || [];
    }
    /**
     * Process a single withdrawal request
     */
    async processRequest(request) {
        try {
            // Validate required fields
            if (!request.chain_id) {
                throw new Error(`Withdrawal request ${request.id} is missing required field: chain_id`);
            }
            // Determine asset_on_chain_id - handle both asset_id and asset_on_chain_id
            let assetOnChain = null;
            if (request.asset_on_chain_id) {
                // Direct asset_on_chain_id provided
                assetOnChain = await this.loadAssetOnChainById(request.asset_on_chain_id);
                if (!assetOnChain) {
                    throw new Error(`Asset on chain not found: asset_on_chain_id=${request.asset_on_chain_id}`);
                }
            }
            else if (request.asset_id) {
                // asset_id provided - need to find asset_on_chain
                assetOnChain = await this.loadAssetOnChain(request.asset_id, request.chain_id);
                if (!assetOnChain) {
                    throw new Error(`Asset not found on chain: asset_id=${request.asset_id}, chain_id=${request.chain_id}`);
                }
            }
            else {
                logger.error({
                    requestId: request.id,
                    requestFields: Object.keys(request),
                    requestData: request,
                }, 'Withdrawal request missing both asset_id and asset_on_chain_id fields');
                throw new Error(`Withdrawal request ${request.id} is missing required field: asset_id or asset_on_chain_id`);
            }
            // 1. Load chain config
            const chainConfig = await this.loadChainConfig(request.chain_id);
            if (!chainConfig) {
                throw new Error(`Chain config not found for chain_id: ${request.chain_id}`);
            }
            // 2. Extract amount (handle both 'amount' and 'amount_human' field names)
            const amountHuman = request.amount_human ?? request.amount;
            if (amountHuman === undefined || amountHuman === null) {
                logger.error({
                    requestId: request.id,
                    requestFields: Object.keys(request),
                    requestData: request,
                }, 'Withdrawal request missing amount field');
                throw new Error(`Withdrawal request ${request.id} is missing required field: amount or amount_human`);
            }
            if (typeof amountHuman !== 'number' || isNaN(amountHuman)) {
                throw new Error(`Withdrawal request ${request.id} has invalid amount: ${amountHuman} (type: ${typeof amountHuman})`);
            }
            // 3. Select hot wallet (round-robin)
            const hotWallet = await this.selectHotWallet(request.chain_id);
            if (!hotWallet) {
                throw new Error(`No active hot wallet found for chain_id: ${request.chain_id}`);
            }
            // 4. Validate decimals
            if (assetOnChain.decimals === undefined || assetOnChain.decimals === null) {
                throw new Error(`Asset on chain ${assetOnChain.id} has invalid decimals: ${assetOnChain.decimals}`);
            }
            // 5. Calculate raw amount
            const amountRaw = this.calculateRawAmount(amountHuman, assetOnChain.decimals);
            logger.info({
                requestId: request.id,
                userId: request.user_id,
                amount: amountHuman,
                amountRaw,
                toAddress: request.to_address,
                chainId: request.chain_id,
                assetId: assetOnChain.asset_id,
                assetOnChainId: assetOnChain.id,
                hotWalletId: hotWallet.id,
                hotWalletAddress: hotWallet.address,
            }, 'Processing withdrawal request');
            // 6. Insert into withdrawal_queue
            const { data: queuedJob, error: insertError } = await this.supabase
                .from('withdrawal_queue')
                .insert({
                withdrawal_request_id: request.id,
                chain_id: request.chain_id,
                asset_on_chain_id: assetOnChain.id,
                operation_wallet_address_id: hotWallet.id,
                to_address: request.to_address,
                amount_raw: amountRaw,
                amount_human: amountHuman,
                status: 'pending',
                priority: 'normal',
                scheduled_at: new Date().toISOString(),
            })
                .select()
                .single();
            if (insertError) {
                throw new Error(`Failed to insert into withdrawal_queue: ${insertError.message}`);
            }
            // 7. Update withdrawal_requests status to 'queued'
            const { error: updateRequestError } = await this.supabase
                .from('withdrawal_requests')
                .update({
                status: 'queued',
                queued_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
                .eq('id', request.id);
            if (updateRequestError) {
                logger.error({ error: updateRequestError.message, requestId: request.id }, 'Failed to update withdrawal_requests status');
                // Note: Job is already in queue, so this is a soft error
            }
            // 8. Update hot wallet last_used_at
            const { error: updateWalletError } = await this.supabase
                .from('operation_wallet_addresses')
                .update({
                last_used_at: new Date().toISOString(),
            })
                .eq('id', hotWallet.id);
            if (updateWalletError) {
                logger.warn({ error: updateWalletError.message, walletId: hotWallet.id }, 'Failed to update hot wallet last_used_at');
                // Non-critical error, continue
            }
            logger.info({
                requestId: request.id,
                queueJobId: queuedJob.id,
                hotWalletId: hotWallet.id,
                hotWalletAddress: hotWallet.address,
                amount: amountHuman,
                amountRaw,
            }, '✅ Withdrawal request enqueued successfully');
        }
        catch (error) {
            logger.error({
                error: error.message,
                requestId: request.id,
                userId: request.user_id,
            }, 'Failed to enqueue withdrawal request');
            // Do NOT update withdrawal_requests - leave it in 'approved' state for retry
        }
    }
    /**
     * Load chain configuration
     */
    async loadChainConfig(chainId) {
        const { data, error } = await this.supabase
            .from('chains')
            .select('id, name, native_currency_decimals')
            .eq('id', chainId)
            .eq('is_active', true)
            .maybeSingle();
        if (error) {
            logger.error({ error: error.message, chainId }, 'Error loading chain config');
            return null;
        }
        return data;
    }
    /**
     * Load asset on chain by asset_id and chain_id
     */
    async loadAssetOnChain(assetId, chainId) {
        const { data, error } = await this.supabase
            .from('asset_on_chain')
            .select('*')
            .eq('asset_id', assetId)
            .eq('chain_id', chainId)
            .eq('is_active', true)
            .maybeSingle();
        if (error) {
            logger.error({ error: error.message, assetId, chainId }, 'Error loading asset on chain');
            return null;
        }
        return data;
    }
    /**
     * Load asset on chain by asset_on_chain_id directly
     */
    async loadAssetOnChainById(assetOnChainId) {
        const { data, error } = await this.supabase
            .from('asset_on_chain')
            .select('*')
            .eq('id', assetOnChainId)
            .eq('is_active', true)
            .maybeSingle();
        if (error) {
            logger.error({ error: error.message, assetOnChainId }, 'Error loading asset on chain by ID');
            return null;
        }
        return data;
    }
    /**
     * Select hot wallet using round-robin strategy (last_used_at ASC)
     */
    async selectHotWallet(chainId) {
        const { data, error } = await this.supabase
            .from('operation_wallet_addresses')
            .select('*')
            .eq('chain_id', chainId)
            .eq('role', 'hot')
            .eq('is_active', true)
            .order('last_used_at', { ascending: true, nullsFirst: true })
            .limit(1)
            .maybeSingle();
        if (error) {
            logger.error({ error: error.message, chainId }, 'Error selecting hot wallet');
            return null;
        }
        return data;
    }
    /**
     * Calculate raw amount (smallest unit) from human amount
     */
    calculateRawAmount(humanAmount, decimals) {
        // Validate inputs
        if (typeof humanAmount !== 'number' || isNaN(humanAmount) || !isFinite(humanAmount)) {
            throw new Error(`Invalid humanAmount: ${humanAmount}`);
        }
        if (typeof decimals !== 'number' || isNaN(decimals) || !Number.isInteger(decimals) || decimals < 0) {
            throw new Error(`Invalid decimals: ${decimals}`);
        }
        try {
            // Convert to string to avoid floating point precision issues
            const humanAmountStr = humanAmount.toString();
            const [integerPart, fractionalPart = ''] = humanAmountStr.split('.');
            // Pad fractional part to decimals length
            const paddedFractional = fractionalPart.padEnd(decimals, '0').slice(0, decimals);
            // Combine integer and fractional parts
            const rawAmountStr = integerPart + paddedFractional;
            // Convert to BigInt and return as string
            return BigInt(rawAmountStr).toString();
        }
        catch (error) {
            throw new Error(`Failed to calculate raw amount: humanAmount=${humanAmount}, decimals=${decimals}, error=${error.message}`);
        }
    }
    /**
     * Start the worker loop
     */
    async start() {
        if (this.isRunning) {
            logger.warn('Withdrawal Enqueue Worker already running');
            return;
        }
        this.isRunning = true;
        this.stopHeartbeat = this.runtime.startHeartbeat(defaultHeartbeatIntervalMs());
        logger.info({ workerId: this.runtime.workerId }, 'Starting Withdrawal Enqueue Worker loop');
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
                logger.error({ error: error.message }, 'Error in Withdrawal Enqueue Worker loop');
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
        logger.info({ workerId: this.runtime.workerId }, 'Stopping Withdrawal Enqueue Worker');
        this.isRunning = false;
    }
}
//# sourceMappingURL=withdrawal-enqueue.worker.js.map
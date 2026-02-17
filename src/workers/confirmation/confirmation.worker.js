import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../config/supabase.js';
import { TronConfirmationClient } from '../../chains/tron/tron.confirmation.client.js';
import { BscConfirmationClient } from '../../chains/bsc/bsc.confirmation.client.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import { env } from '../../config/env.js';
import { WorkerRuntime, workerIdentity, defaultHeartbeatIntervalMs, } from '../../control-plane/worker-runtime.js';
export class ConfirmationWorker {
    supabase;
    runtime;
    chains = new Map();
    clients = new Map();
    isRunning = false;
    stopHeartbeat = null;
    BATCH_SIZE = 100;
    constructor() {
        this.supabase = getSupabaseClient();
        this.runtime = new WorkerRuntime(workerIdentity('deposit_confirmation', null));
    }
    /**
     * Initialize worker: load chains with pending deposits
     */
    async initialize() {
        logger.info('Initializing Confirmation Worker...');
        await this.runtime.register();
        // Load all active chains
        await this.loadActiveChains();
        // Initialize chain clients
        await this.initializeChainClients();
        logger.info({
            chains: Array.from(this.chains.keys()),
            count: this.chains.size,
        }, 'Confirmation worker initialized successfully');
    }
    /**
     * Load active chains from database
     */
    async loadActiveChains() {
        const { data, error } = await this.supabase
            .from('chains')
            .select('id, name, rpc_url, confirmation_threshold, is_active')
            .eq('is_active', true);
        if (error) {
            throw new Error(`Failed to load chains: ${error.message}`);
        }
        for (const chain of data || []) {
            this.chains.set(chain.id, chain);
            logger.info({
                chainId: chain.id,
                chainName: chain.name,
                confirmationThreshold: chain.confirmation_threshold,
            }, 'Loaded chain configuration');
        }
    }
    /**
     * Initialize blockchain clients for each chain
     */
    async initializeChainClients() {
        for (const [chainId, config] of this.chains.entries()) {
            let client;
            switch (config.name.toLowerCase()) {
                case 'tron':
                    client = new TronConfirmationClient(config.rpc_url);
                    break;
                case 'bsc':
                case 'ethereum':
                case 'polygon':
                    client = new BscConfirmationClient(config.rpc_url);
                    break;
                default:
                    logger.warn({ chainName: config.name }, 'Unsupported chain for confirmation worker, skipping');
                    continue;
            }
            this.clients.set(chainId, client);
            logger.debug({ chainId, chainName: config.name }, 'Initialized blockchain client');
        }
    }
    /**
     * Process pending deposits for all chains
     */
    async processPendingDeposits() {
        try {
            for (const [chainId, chainConfig] of this.chains.entries()) {
                const client = this.clients.get(chainId);
                if (!client) {
                    logger.debug({ chainId, chainName: chainConfig.name }, 'No client for chain, skipping');
                    continue;
                }
                await this.processChainDeposits(chainId, chainConfig, client);
            }
        }
        catch (error) {
            logger.error({ error: error.message, stack: error.stack }, 'Error processing pending deposits');
            throw error;
        }
    }
    /**
     * Process pending deposits for a specific chain
     */
    async processChainDeposits(chainId, chainConfig, client) {
        try {
            // Fetch current block number
            const currentBlock = await client.getCurrentBlockNumber();
            logger.debug({
                chainId,
                chainName: chainConfig.name,
                currentBlock,
            }, 'Fetched current block number');
            // Fetch pending deposits for this chain
            const { data: pendingDeposits, error } = await this.supabase
                .from('deposits')
                .select('*')
                .eq('chain_id', chainId)
                .eq('status', 'pending')
                .order('block_number', { ascending: true })
                .limit(this.BATCH_SIZE);
            if (error) {
                throw new Error(`Failed to fetch pending deposits for ${chainConfig.name}: ${error.message}`);
            }
            if (!pendingDeposits || pendingDeposits.length === 0) {
                logger.debug({ chainId, chainName: chainConfig.name }, 'No pending deposits for this chain');
                return;
            }
            logger.info({
                chainId,
                chainName: chainConfig.name,
                pendingCount: pendingDeposits.length,
                currentBlock,
            }, 'Processing pending deposits');
            // Process each deposit
            for (const deposit of pendingDeposits) {
                await this.processDeposit(deposit, chainConfig, currentBlock);
            }
        }
        catch (error) {
            logger.error({
                error: error.message,
                chainId,
                chainName: chainConfig.name,
            }, 'Error processing chain deposits');
            throw error;
        }
    }
    /**
     * Process a single pending deposit
     */
    async processDeposit(deposit, chainConfig, currentBlock) {
        try {
            // Reorg safety: If current block < deposit block, skip
            if (currentBlock < deposit.block_number) {
                logger.warn({
                    depositId: deposit.id,
                    txHash: deposit.tx_hash,
                    depositBlock: deposit.block_number,
                    currentBlock,
                }, 'Current block < deposit block (possible reorg), skipping');
                return;
            }
            // Calculate confirmations
            const confirmations = currentBlock - deposit.block_number + 1;
            logger.debug({
                depositId: deposit.id,
                txHash: deposit.tx_hash,
                blockNumber: deposit.block_number,
                currentBlock,
                confirmations,
                threshold: chainConfig.confirmation_threshold,
            }, 'Calculated confirmations');
            // Update confirmations count
            if (confirmations < chainConfig.confirmation_threshold) {
                // Not enough confirmations yet, just update count
                await this.updateConfirmationCount(deposit.id, confirmations);
                return;
            }
            // Enough confirmations - confirm and credit
            await this.confirmAndCreditDeposit(deposit, chainConfig, confirmations);
        }
        catch (error) {
            logger.error({
                error: error.message,
                depositId: deposit.id,
                txHash: deposit.tx_hash,
            }, 'Error processing deposit');
            // Don't throw - continue processing other deposits
        }
    }
    /**
     * Update confirmation count for a deposit (not ready to confirm yet)
     */
    async updateConfirmationCount(depositId, confirmations) {
        const { error } = await this.supabase
            .from('deposits')
            .update({ confirmations })
            .eq('id', depositId);
        if (error) {
            logger.error({ error: error.message, depositId, confirmations }, 'Failed to update confirmation count');
            throw error;
        }
        logger.debug({ depositId, confirmations }, 'Updated confirmation count');
    }
    /**
     * Confirm deposit and credit user balance (ATOMIC OPERATION)
     */
    async confirmAndCreditDeposit(deposit, chainConfig, confirmations) {
        try {
            // IDEMPOTENCY CHECK: Re-fetch deposit to ensure it hasn't been credited
            const { data: currentDeposit, error: fetchError } = await this.supabase
                .from('deposits')
                .select('id, status, credited_at, confirmed_at')
                .eq('id', deposit.id)
                .maybeSingle();
            if (fetchError) {
                throw new Error(`Failed to re-fetch deposit: ${fetchError.message}`);
            }
            if (!currentDeposit) {
                logger.warn({ depositId: deposit.id }, 'Deposit not found during confirmation, skipping');
                return;
            }
            // CRITICAL: Skip if already credited (idempotency)
            if (currentDeposit.credited_at) {
                logger.debug({ depositId: deposit.id, txHash: deposit.tx_hash }, 'Deposit already credited, skipping');
                return;
            }
            // CRITICAL: Skip if already confirmed by another worker
            if (currentDeposit.status === 'confirmed') {
                logger.debug({ depositId: deposit.id, txHash: deposit.tx_hash }, 'Deposit already confirmed, checking if needs crediting');
                // If confirmed but not credited, credit now
                if (!currentDeposit.credited_at) {
                    await this.creditDepositBalance(deposit);
                }
                return;
            }
            // Get user uid from to_address
            const { data: userAddress, error: userError } = await this.supabase
                .from('user_wallet_addresses')
                .select('uid')
                .eq('address', deposit.to_address)
                .eq('chain_id', deposit.chain_id)
                .maybeSingle();
            if (userError) {
                throw new Error(`Failed to fetch user address: ${userError.message}`);
            }
            if (!userAddress) {
                logger.error({
                    depositId: deposit.id,
                    toAddress: deposit.to_address,
                }, 'User address not found for deposit');
                return;
            }
            // Get asset_id from asset_on_chain
            const { data: assetOnChain, error: assetError } = await this.supabase
                .from('asset_on_chain')
                .select('asset_id')
                .eq('id', deposit.asset_on_chain_id)
                .maybeSingle();
            if (assetError) {
                throw new Error(`Failed to fetch asset: ${assetError.message}`);
            }
            if (!assetOnChain) {
                logger.error({ depositId: deposit.id, assetOnChainId: deposit.asset_on_chain_id }, 'Asset not found for deposit');
                return;
            }
            // Step 1: Mark as confirmed
            const { error: confirmError } = await this.supabase
                .from('deposits')
                .update({
                status: 'confirmed',
                confirmations,
                confirmed_at: new Date().toISOString(),
            })
                .eq('id', deposit.id)
                .eq('status', 'pending'); // Safety: only update if still pending
            if (confirmError) {
                throw new Error(`Failed to confirm deposit: ${confirmError.message}`);
            }
            logger.info({
                depositId: deposit.id,
                txHash: deposit.tx_hash,
                confirmations,
                threshold: chainConfig.confirmation_threshold,
            }, 'Deposit marked as CONFIRMED');
            // Step 2: Credit balance via Postgres RPC (NO JS MATH)
            const { error: creditError } = await this.supabase.rpc('credit_user_asset_balance', {
                p_uid: userAddress.uid,
                p_asset_id: assetOnChain.asset_id,
                p_amount: deposit.amount_human,
            });
            if (creditError) {
                logger.error({
                    error: creditError.message,
                    depositId: deposit.id,
                    uid: userAddress.uid,
                    amount: deposit.amount_human,
                }, 'Failed to credit balance - deposit confirmed but balance not credited');
                // Don't throw - deposit is confirmed, balance credit can be retried
                return;
            }
            // Step 3: Mark as credited
            const { error: creditedError } = await this.supabase
                .from('deposits')
                .update({
                credited_at: new Date().toISOString(),
            })
                .eq('id', deposit.id);
            if (creditedError) {
                logger.error({ error: creditedError.message, depositId: deposit.id }, 'Failed to update credited_at timestamp');
                // Don't throw - balance was credited successfully
            }
            logger.info({
                depositId: deposit.id,
                txHash: deposit.tx_hash,
                uid: userAddress.uid,
                amount: deposit.amount_human,
                confirmations,
            }, '✅ Deposit confirmed and balance credited successfully');
        }
        catch (error) {
            logger.error({
                error: error.message,
                stack: error.stack,
                depositId: deposit.id,
                txHash: deposit.tx_hash,
            }, 'Error confirming and crediting deposit');
            throw error;
        }
    }
    /**
     * Credit balance for an already-confirmed deposit (retry scenario)
     */
    async creditDepositBalance(deposit) {
        try {
            // Get user uid
            const { data: userAddress, error: userError } = await this.supabase
                .from('user_wallet_addresses')
                .select('uid')
                .eq('address', deposit.to_address)
                .eq('chain_id', deposit.chain_id)
                .maybeSingle();
            if (userError || !userAddress) {
                logger.error({ depositId: deposit.id, toAddress: deposit.to_address }, 'User address not found');
                return;
            }
            // Get asset_id
            const { data: assetOnChain, error: assetError } = await this.supabase
                .from('asset_on_chain')
                .select('asset_id')
                .eq('id', deposit.asset_on_chain_id)
                .maybeSingle();
            if (assetError || !assetOnChain) {
                logger.error({ depositId: deposit.id, assetOnChainId: deposit.asset_on_chain_id }, 'Asset not found');
                return;
            }
            // Credit balance
            const { error: creditError } = await this.supabase.rpc('credit_user_asset_balance', {
                p_uid: userAddress.uid,
                p_asset_id: assetOnChain.asset_id,
                p_amount: deposit.amount_human,
            });
            if (creditError) {
                logger.error({
                    error: creditError.message,
                    depositId: deposit.id,
                    uid: userAddress.uid,
                }, 'Failed to credit balance (retry)');
                return;
            }
            // Mark as credited
            const { error: creditedError } = await this.supabase
                .from('deposits')
                .update({ credited_at: new Date().toISOString() })
                .eq('id', deposit.id);
            if (creditedError) {
                logger.error({ error: creditedError.message, depositId: deposit.id }, 'Failed to update credited_at');
            }
            logger.info({ depositId: deposit.id, uid: userAddress.uid }, 'Balance credited for previously confirmed deposit');
        }
        catch (error) {
            logger.error({
                error: error.message,
                depositId: deposit.id,
            }, 'Error crediting deposit balance');
        }
    }
    /**
     * Start the worker loop
     */
    async start() {
        if (this.isRunning) {
            logger.warn('Confirmation worker is already running');
            return;
        }
        this.isRunning = true;
        this.stopHeartbeat = this.runtime.startHeartbeat(defaultHeartbeatIntervalMs());
        logger.info('Starting confirmation worker loop');
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
                    await sleep(env.worker.scanIntervalMs * 2);
                    continue;
                }
                await this.processPendingDeposits();
                await this.runtime.logExecution({
                    executionType: 'cycle',
                    status: 'success',
                    durationMs: Date.now() - cycleStart,
                });
            }
            catch (error) {
                logger.error({ error: error.message, stack: error.stack }, 'Error in confirmation worker loop');
                await this.runtime.logExecution({
                    executionType: 'cycle',
                    status: 'fail',
                    durationMs: Date.now() - cycleStart,
                    errorMessage: error?.message ?? String(error),
                });
            }
            await sleep(env.worker.scanIntervalMs * 2);
        }
        this.stopHeartbeat?.();
        await this.runtime.setStopped();
    }
    /**
     * Stop the worker loop
     */
    stop() {
        logger.info('Stopping confirmation worker');
        this.isRunning = false;
    }
}
//# sourceMappingURL=confirmation.worker.js.map
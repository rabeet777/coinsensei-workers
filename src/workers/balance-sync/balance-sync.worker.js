import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../config/supabase.js';
import { TronBalanceClient } from '../../chains/tron/tron.balance.client.js';
import { BscBalanceClient } from '../../chains/bsc/bsc.balance.client.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import { WorkerRuntime, workerIdentity, defaultHeartbeatIntervalMs, } from '../../control-plane/worker-runtime.js';
export class BalanceSyncWorker {
    supabase;
    runtime;
    chainClients = new Map();
    isRunning = false;
    stopHeartbeat = null;
    BATCH_SIZE = 50;
    LOCK_DURATION_SECONDS = 120; // 2 minutes
    SYNC_INTERVAL_MS = 30000; // 30 seconds
    constructor() {
        this.supabase = getSupabaseClient();
        this.runtime = new WorkerRuntime(workerIdentity('balance_sync', null));
    }
    get WORKER_ID() {
        return this.runtime.workerId;
    }
    /**
     * Initialize worker: load chains and create clients
     */
    async initialize() {
        logger.info('Initializing Balance Sync Worker...');
        await this.runtime.register();
        await this.initializeChainClients();
        logger.info({
            workerId: this.runtime.workerId,
            chains: Array.from(this.chainClients.keys()),
            batchSize: this.BATCH_SIZE,
        }, 'Balance Sync Worker initialized successfully');
    }
    /**
     * Initialize blockchain clients for active chains
     */
    async initializeChainClients() {
        const { data: chains, error } = await this.supabase
            .from('chains')
            .select('id, name, rpc_url, is_active')
            .eq('is_active', true);
        if (error) {
            throw new Error(`Failed to load chains: ${error.message}`);
        }
        for (const chain of chains || []) {
            let client;
            switch (chain.name.toLowerCase()) {
                case 'tron':
                    client = new TronBalanceClient(chain.rpc_url);
                    break;
                case 'bsc':
                case 'ethereum':
                case 'polygon':
                    client = new BscBalanceClient(chain.rpc_url);
                    break;
                default:
                    logger.warn({ chainName: chain.name }, 'Unsupported chain for balance sync, skipping');
                    continue;
            }
            this.chainClients.set(chain.id, {
                client,
                name: chain.name,
                rpcUrl: chain.rpc_url,
            });
            logger.info({ chainId: chain.id, chainName: chain.name }, 'Initialized chain client for balance sync');
        }
    }
    /**
     * Process a batch of wallet balances
     */
    async processBatch() {
        try {
            // Step 1: Select and lock rows
            const lockedRows = await this.selectAndLockRows();
            if (lockedRows.length === 0) {
                logger.debug('No wallet balances to process');
                return;
            }
            logger.info({ count: lockedRows.length, workerId: this.WORKER_ID }, 'Processing batch of wallet balances');
            // Step 2: Process each locked row
            for (const row of lockedRows) {
                await this.processWalletBalance(row);
            }
            logger.info({ processed: lockedRows.length }, 'Batch processing complete');
        }
        catch (error) {
            logger.error({ error: error.message, stack: error.stack }, 'Error processing batch');
            // Don't throw - continue to next cycle
        }
    }
    /**
     * Select and lock rows for processing
     * CRITICAL: Selects ALL wallet_balances rows (both user and operation wallets)
     * No filtering by wallet type - balance sync must handle both
     */
    async selectAndLockRows() {
        const lockUntil = new Date(Date.now() + this.LOCK_DURATION_SECONDS * 1000).toISOString();
        try {
            // Select idle rows that aren't locked
            // IMPORTANT: No filtering by wallet type - includes both user_wallet_addresses and operation_wallet_addresses
            const { data: availableRows, error: selectError } = await this.supabase
                .from('wallet_balances')
                .select('*')
                .eq('processing_status', 'idle')
                .or(`locked_until.is.null,locked_until.lt.${new Date().toISOString()}`)
                .order('last_checked', { ascending: true, nullsFirst: true })
                .limit(this.BATCH_SIZE);
            if (selectError) {
                logger.error({ error: selectError.message }, 'Failed to select wallet balances');
                return [];
            }
            if (!availableRows || availableRows.length === 0) {
                return [];
            }
            // Log wallet types for debugging (verify both user and operation wallets are selected)
            const walletIds = availableRows.map((r) => r.wallet_id);
            const { data: userWallets } = await this.supabase
                .from('user_wallet_addresses')
                .select('id')
                .in('id', walletIds);
            const { data: operationWallets } = await this.supabase
                .from('operation_wallet_addresses')
                .select('id')
                .in('id', walletIds);
            const userWalletIds = new Set(userWallets?.map((w) => w.id) || []);
            const operationWalletIds = new Set(operationWallets?.map((w) => w.id) || []);
            logger.debug({
                totalRows: availableRows.length,
                userWallets: userWalletIds.size,
                operationWallets: operationWalletIds.size,
            }, 'Selected wallet balances (includes both user and operation wallets)');
            // Lock selected rows
            const rowIds = availableRows.map((r) => r.id);
            const { error: lockError } = await this.supabase
                .from('wallet_balances')
                .update({
                locked_until: lockUntil,
                locked_by: this.WORKER_ID,
                processing_status: 'processing',
            })
                .in('id', rowIds)
                .eq('processing_status', 'idle'); // Only lock if still idle
            if (lockError) {
                logger.error({ error: lockError.message, rowCount: rowIds.length }, 'Failed to lock rows');
                return [];
            }
            logger.debug({ locked: rowIds.length, workerId: this.WORKER_ID }, 'Locked wallet balance rows');
            return availableRows;
        }
        catch (error) {
            logger.error({ error: error.message }, 'Error in selectAndLockRows');
            return [];
        }
    }
    /**
     * Process a single wallet balance row
     */
    async processWalletBalance(row) {
        try {
            // Load asset configuration
            const { data: assetOnChain, error: assetError } = await this.supabase
                .from('asset_on_chain')
                .select('id, chain_id, asset_id, contract_address, decimals, is_native')
                .eq('id', row.asset_on_chain_id)
                .maybeSingle();
            if (assetError || !assetOnChain) {
                throw new Error(`Failed to load asset: ${assetError?.message || 'not found'}`);
            }
            // Load chain configuration
            const { data: chain, error: chainError } = await this.supabase
                .from('chains')
                .select('id, name, is_active')
                .eq('id', assetOnChain.chain_id)
                .maybeSingle();
            if (chainError || !chain) {
                throw new Error(`Failed to load chain: ${chainError?.message || 'not found'}`);
            }
            // Skip if chain is not active
            if (!chain.is_active) {
                logger.warn({ walletBalanceId: row.id, chainName: chain.name }, 'Chain is not active, skipping');
                await this.releaseLock(row.id, false);
                return;
            }
            // Load wallet address for this chain
            // wallet_balances.wallet_id can reference either user_wallet_addresses.id or operation_wallet_addresses.id
            // CRITICAL: Balance sync must handle BOTH user and operation wallets
            let walletAddress = null;
            let walletType = null;
            // Try user_wallet_addresses first
            const { data: userWalletAddress, error: userAddressError } = await this.supabase
                .from('user_wallet_addresses')
                .select('address, chain_id, is_active')
                .eq('id', row.wallet_id)
                .eq('chain_id', assetOnChain.chain_id)
                .eq('is_active', true)
                .maybeSingle();
            if (userAddressError) {
                // Database error - log but continue to try operation_wallet_addresses
                logger.debug({ error: userAddressError.message, walletId: row.wallet_id }, 'Error querying user_wallet_addresses, trying operation_wallet_addresses');
            }
            else if (userWalletAddress) {
                walletAddress = userWalletAddress;
                walletType = 'user';
                logger.debug({ walletId: row.wallet_id, walletType: 'user' }, 'Found wallet in user_wallet_addresses');
            }
            // If not found in user_wallet_addresses, try operation_wallet_addresses
            if (!walletAddress) {
                const { data: operationWalletAddress, error: operationAddressError } = await this.supabase
                    .from('operation_wallet_addresses')
                    .select('address, chain_id, is_active')
                    .eq('id', row.wallet_id)
                    .eq('chain_id', assetOnChain.chain_id)
                    .eq('is_active', true)
                    .maybeSingle();
                if (operationAddressError) {
                    // Both queries failed - this is an error
                    throw new Error(`Failed to load wallet address from both tables: wallet_id=${row.wallet_id}, chain_id=${assetOnChain.chain_id}, user_error=${userAddressError?.message || 'not found'}, operation_error=${operationAddressError.message}`);
                }
                else if (operationWalletAddress) {
                    walletAddress = operationWalletAddress;
                    walletType = 'operation';
                    logger.debug({ walletId: row.wallet_id, walletType: 'operation' }, 'Found wallet in operation_wallet_addresses');
                }
            }
            if (!walletAddress) {
                throw new Error(`Wallet address not found in user_wallet_addresses or operation_wallet_addresses: wallet_id=${row.wallet_id}, chain_id=${assetOnChain.chain_id}`);
            }
            logger.debug({ walletId: row.wallet_id, walletType, address: walletAddress.address }, 'Loaded wallet address');
            // Get chain client
            const chainClient = this.chainClients.get(assetOnChain.chain_id);
            if (!chainClient) {
                throw new Error(`No client for chain ${chain.name}`);
            }
            // Fetch on-chain balance (data-driven: native or token)
            const { balanceRaw, balanceHuman } = await this.fetchOnChainBalance(chainClient.client, assetOnChain, walletAddress.address);
            // Update wallet_balances (balance fields only)
            await this.updateBalance(row.id, balanceRaw, balanceHuman);
            // Release lock after successful sync
            await this.releaseLock(row.id, true);
            logger.info({
                walletBalanceId: row.id,
                walletId: row.wallet_id,
                walletType, // 'user' or 'operation'
                chain: chain.name,
                assetType: assetOnChain.is_native ? 'Native' : 'Token',
                assetId: assetOnChain.asset_id,
                balanceHuman,
            }, 'Wallet balance synced successfully');
        }
        catch (error) {
            logger.error({
                error: error.message,
                walletBalanceId: row.id,
            }, 'Error processing wallet balance');
            // Record error and release lock
            await this.recordError(row.id, error.message);
        }
    }
    /**
     * Fetch on-chain balance for an asset (DATA-DRIVEN)
     * Handles both native assets (TRX, BNB) and token assets (USDT, etc.)
     * based on asset_on_chain.is_native flag
     */
    async fetchOnChainBalance(client, asset, walletAddress) {
        let balanceRaw;
        if (asset.is_native) {
            // Data-driven: Fetch native balance (TRX, BNB, ETH, etc.)
            // No hardcoded asset symbols - driven by is_native flag
            balanceRaw = await client.getNativeBalance(walletAddress);
            logger.debug({
                walletAddress: walletAddress.substring(0, 10) + '...',
                assetId: asset.asset_id,
                isNative: true,
                balanceRaw,
            }, 'Fetched native asset balance');
        }
        else {
            // Data-driven: Fetch token balance (TRC20, BEP20, ERC20, etc.)
            // Uses contract_address from asset_on_chain table
            if (!asset.contract_address) {
                throw new Error('Contract address is null for non-native asset');
            }
            balanceRaw = await client.getTokenBalance(asset.contract_address, walletAddress);
            logger.debug({
                walletAddress: walletAddress.substring(0, 10) + '...',
                assetId: asset.asset_id,
                isNative: false,
                contractAddress: asset.contract_address.substring(0, 10) + '...',
                balanceRaw,
            }, 'Fetched token asset balance');
        }
        // Calculate human-readable amount using decimals from asset_on_chain
        const balanceHuman = client.calculateHumanAmount(balanceRaw, asset.decimals);
        return { balanceRaw, balanceHuman };
    }
    /**
     * Update wallet_balances with new on-chain balance
     * ONLY updates balance-related fields, does NOT touch lock/status fields
     */
    async updateBalance(walletBalanceId, balanceRaw, balanceHuman) {
        // First get current sync_count
        const { data: currentRow } = await this.supabase
            .from('wallet_balances')
            .select('sync_count')
            .eq('id', walletBalanceId)
            .maybeSingle();
        const newSyncCount = (currentRow?.sync_count || 0) + 1;
        // ONLY update balance-related fields
        // DO NOT touch: needs_gas, needs_consolidation, locks, priorities, processing_status
        const { error } = await this.supabase
            .from('wallet_balances')
            .update({
            on_chain_balance_raw: balanceRaw,
            on_chain_balance_human: balanceHuman,
            last_checked: new Date().toISOString(),
            sync_count: newSyncCount,
            updated_at: new Date().toISOString(),
        })
            .eq('id', walletBalanceId);
        if (error) {
            throw new Error(`Failed to update balance: ${error.message}`);
        }
    }
    /**
     * Release lock after processing (success or failure)
     */
    async releaseLock(walletBalanceId, success) {
        const updateData = {
            processing_status: 'idle',
            locked_until: null,
            locked_by: null,
            last_processed_at: new Date().toISOString(),
        };
        // On success, clear error fields
        if (success) {
            updateData.last_error = null;
            updateData.last_error_at = null;
        }
        const { error } = await this.supabase
            .from('wallet_balances')
            .update(updateData)
            .eq('id', walletBalanceId);
        if (error) {
            logger.error({ error: error.message, walletBalanceId }, 'Failed to release lock');
        }
    }
    /**
     * Record error and release lock
     */
    async recordError(walletBalanceId, errorMessage) {
        // Get current error_count
        const { data: currentRow } = await this.supabase
            .from('wallet_balances')
            .select('error_count')
            .eq('id', walletBalanceId)
            .maybeSingle();
        const newErrorCount = (currentRow?.error_count || 0) + 1;
        const { error } = await this.supabase
            .from('wallet_balances')
            .update({
            last_error: errorMessage,
            last_error_at: new Date().toISOString(),
            error_count: newErrorCount,
        })
            .eq('id', walletBalanceId);
        if (error) {
            logger.error({
                error: error.message,
                walletBalanceId,
            }, 'Failed to record error');
        }
        // Release lock separately
        await this.releaseLock(walletBalanceId, false);
    }
    /**
     * Start the worker loop
     */
    async start() {
        if (this.isRunning) {
            logger.warn('Balance sync worker is already running');
            return;
        }
        this.isRunning = true;
        this.stopHeartbeat = this.runtime.startHeartbeat(defaultHeartbeatIntervalMs());
        logger.info({ workerId: this.runtime.workerId }, 'Starting balance sync worker loop');
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
                    await sleep(this.SYNC_INTERVAL_MS);
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
                logger.error({ error: error.message, stack: error.stack }, 'Error in worker loop');
                await this.runtime.logExecution({
                    executionType: 'cycle',
                    status: 'fail',
                    durationMs: Date.now() - cycleStart,
                    errorMessage: error?.message ?? String(error),
                });
            }
            await sleep(this.SYNC_INTERVAL_MS);
        }
        this.stopHeartbeat?.();
        await this.runtime.setStopped();
    }
    /**
     * Stop the worker loop
     */
    stop() {
        logger.info({ workerId: this.runtime.workerId }, 'Stopping balance sync worker');
        this.isRunning = false;
    }
    /**
     * Release all locks held by this worker (cleanup)
     */
    async releaseAllLocks() {
        try {
            const { error } = await this.supabase
                .from('wallet_balances')
                .update({
                processing_status: 'idle',
                locked_until: null,
                locked_by: null,
            })
                .eq('locked_by', this.runtime.workerId);
            if (error) {
                logger.error({ error: error.message }, 'Failed to release locks');
            }
            else {
                logger.info({ workerId: this.WORKER_ID }, 'Released all locks');
            }
        }
        catch (error) {
            logger.error({ error: error.message }, 'Error releasing locks');
        }
    }
}
//# sourceMappingURL=balance-sync.worker.js.map
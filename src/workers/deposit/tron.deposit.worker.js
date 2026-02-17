import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../config/supabase.js';
import { TronClient } from '../../chains/tron/tron.client.js';
import { TronTRC20TransferParser } from '../../chains/tron/tron.usdt.parser.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import { env } from '../../config/env.js';
import { WorkerRuntime, workerIdentity, defaultHeartbeatIntervalMs, } from '../../control-plane/worker-runtime.js';
export class TronDepositWorker {
    supabase;
    runtime = null;
    tronClient = null;
    chainConfig = null;
    activeAssets = [];
    userAddressMap = new Map();
    isRunning = false;
    stopHeartbeat = null;
    constructor() {
        this.supabase = getSupabaseClient();
    }
    /**
     * Initialize worker: load chain config, assets, and user addresses
     */
    async initialize() {
        logger.info('Initializing TRON deposit worker...');
        // Load TRON chain configuration
        await this.loadChainConfig();
        this.runtime = new WorkerRuntime(workerIdentity('deposit_listener', this.chainConfig.id));
        await this.runtime.register();
        // Load active TRC20 assets
        await this.loadActiveAssets();
        // Load user wallet addresses
        await this.loadUserAddresses();
        // Initialize last processed block if needed
        await this.initializeWorkerState();
        logger.info({
            chain: this.chainConfig?.name,
            assets: this.activeAssets.length,
            userAddresses: this.userAddressMap.size,
        }, 'TRON deposit worker initialized successfully');
    }
    /**
     * Load TRON chain configuration from database
     */
    async loadChainConfig() {
        const { data, error } = await this.supabase
            .from('chains')
            .select('id, name, rpc_url, confirmation_threshold, is_active')
            .eq('name', 'tron')
            .eq('is_active', true)
            .single();
        if (error || !data) {
            throw new Error(`Failed to load TRON chain config: ${error?.message}`);
        }
        this.chainConfig = data;
        // Initialize TRON client
        const tronConfig = {
            chainId: data.id,
            name: data.name,
            rpcUrl: data.rpc_url,
            confirmationThreshold: data.confirmation_threshold,
        };
        this.tronClient = new TronClient(tronConfig);
        logger.info({
            chainId: data.id,
            rpcUrl: data.rpc_url,
            confirmations: data.confirmation_threshold,
        }, 'Loaded TRON chain configuration');
    }
    /**
     * Load active TRC20 assets from database
     */
    async loadActiveAssets() {
        if (!this.chainConfig) {
            throw new Error('Chain config not loaded');
        }
        const { data, error } = await this.supabase
            .from('asset_on_chain')
            .select('id, chain_id, contract_address, decimals, is_active, asset_id')
            .eq('chain_id', this.chainConfig.id)
            .eq('is_active', true)
            .not('contract_address', 'is', null);
        if (error) {
            throw new Error(`Failed to load active assets: ${error.message}`);
        }
        this.activeAssets = data || [];
        logger.info({
            count: this.activeAssets.length,
            assets: this.activeAssets.map((a) => a.contract_address),
        }, 'Loaded active TRC20 assets');
    }
    /**
     * Load user wallet addresses for TRON chain
     */
    async loadUserAddresses() {
        if (!this.chainConfig) {
            throw new Error('Chain config not loaded');
        }
        // Load all user wallet addresses for this chain
        let query = this.supabase
            .from('user_wallet_addresses')
            .select('*')
            .eq('chain_id', this.chainConfig.id);
        const { data, error } = await query;
        if (error) {
            throw new Error(`Failed to load user addresses: ${error.message}`);
        }
        // Build address map for quick lookup
        this.userAddressMap.clear();
        for (const addr of data || []) {
            this.userAddressMap.set(addr.address.toLowerCase(), addr);
        }
        logger.info({ count: this.userAddressMap.size }, 'Loaded user wallet addresses');
    }
    /**
     * Initialize worker state in database if not exists
     */
    async initializeWorkerState() {
        if (!this.chainConfig || !this.tronClient) {
            throw new Error('Chain config or client not initialized');
        }
        const { data: existingState } = await this.supabase
            .from('worker_chain_state')
            .select('chain_id, last_processed_block')
            .eq('chain_id', this.chainConfig.id)
            .maybeSingle();
        if (!existingState) {
            // Initialize with (current_block - confirmation_threshold)
            const currentBlock = await this.tronClient.getCurrentBlockNumber();
            const startBlock = currentBlock - this.chainConfig.confirmation_threshold;
            const { error } = await this.supabase
                .from('worker_chain_state')
                .insert({
                chain_id: this.chainConfig.id,
                last_processed_block: startBlock,
                updated_at: new Date().toISOString(),
            });
            if (error) {
                throw new Error(`Failed to initialize worker state: ${error.message}`);
            }
            logger.info({ startBlock, currentBlock }, 'Initialized worker state');
        }
        else {
            logger.info({ lastProcessedBlock: existingState.last_processed_block }, 'Worker state already exists');
        }
    }
    /**
     * Get current worker state
     */
    async getWorkerState() {
        if (!this.chainConfig) {
            throw new Error('Chain config not loaded');
        }
        const { data, error } = await this.supabase
            .from('worker_chain_state')
            .select('chain_id, last_processed_block')
            .eq('chain_id', this.chainConfig.id)
            .maybeSingle();
        if (error) {
            throw new Error(`Failed to get worker state: ${error.message}`);
        }
        if (!data) {
            throw new Error('Worker state not found - run initialization first');
        }
        return data;
    }
    /**
     * Update worker state with new last processed block
     */
    async updateWorkerState(blockNumber) {
        if (!this.chainConfig) {
            throw new Error('Chain config not loaded');
        }
        const { error } = await this.supabase
            .from('worker_chain_state')
            .update({
            last_processed_block: blockNumber,
            updated_at: new Date().toISOString(),
        })
            .eq('chain_id', this.chainConfig.id);
        if (error) {
            throw new Error(`Failed to update worker state: ${error.message}`);
        }
    }
    /**
     * Scan TRON deposits for all active assets
     */
    async scanDeposits() {
        if (!this.tronClient || !this.chainConfig) {
            throw new Error('Worker not initialized');
        }
        try {
            // Get current block and calculate safe block
            const currentBlock = await this.tronClient.getCurrentBlockNumber();
            const safeBlock = currentBlock - this.chainConfig.confirmation_threshold;
            // Get last processed block
            const state = await this.getWorkerState();
            const fromBlock = state.last_processed_block + 1;
            if (fromBlock > safeBlock) {
                logger.debug({ fromBlock, safeBlock, currentBlock }, 'No new confirmed blocks to process');
                return;
            }
            // Limit batch size to avoid overload
            const toBlock = Math.min(safeBlock, fromBlock + env.worker.batchBlockSize - 1);
            logger.info({ fromBlock, toBlock, currentBlock, safeBlock }, 'Scanning block range for deposits');
            // Process each active asset
            for (const asset of this.activeAssets) {
                await this.processAssetDeposits(asset, fromBlock, toBlock);
            }
            // Update worker state after successful processing
            await this.updateWorkerState(toBlock);
            logger.info({ processedBlocks: toBlock - fromBlock + 1, lastBlock: toBlock }, 'Successfully processed block range');
        }
        catch (error) {
            logger.error({ error: error.message, stack: error.stack }, 'Error scanning deposits');
            throw error;
        }
    }
    /**
     * Process deposits for a specific asset
     */
    async processAssetDeposits(asset, fromBlock, toBlock) {
        if (!this.tronClient) {
            throw new Error('TRON client not initialized');
        }
        try {
            // Fetch TRC20 Transfer events
            const transfers = await this.tronClient.getTRC20Transfers(asset.contract_address, fromBlock, toBlock);
            logger.debug({
                asset: asset.contract_address,
                transfers: transfers.length,
                fromBlock,
                toBlock,
            }, 'Fetched TRC20 transfers');
            // Process each transfer
            for (const transfer of transfers) {
                // Validate transfer
                if (!TronTRC20TransferParser.isValidTransfer(transfer)) {
                    logger.warn({ transfer }, 'Invalid transfer, skipping');
                    continue;
                }
                // Parse transfer
                const parsed = TronTRC20TransferParser.parseTransfer(transfer, asset.id);
                logger.debug({
                    txHash: parsed.txHash,
                    to: parsed.to,
                    toLower: parsed.to.toLowerCase(),
                    amount: parsed.amountRaw,
                    monitoredAddresses: Array.from(this.userAddressMap.keys()),
                }, 'Checking if transfer is to monitored address');
                // Filter: only process deposits to user addresses
                const userAddress = this.userAddressMap.get(parsed.to.toLowerCase());
                if (!userAddress) {
                    logger.debug({ to: parsed.to, txHash: parsed.txHash }, 'Transfer not to monitored address, skipping');
                    continue;
                }
                logger.info({
                    txHash: parsed.txHash,
                    to: parsed.to,
                    amount: parsed.amountRaw,
                }, '✅ Found deposit to monitored address!');
                // Process the deposit
                await this.processDeposit(parsed, asset, userAddress);
            }
        }
        catch (error) {
            logger.error({
                error: error.message,
                asset: asset.contract_address,
                fromBlock,
                toBlock,
            }, 'Error processing asset deposits');
            throw error;
        }
    }
    /**
     * Process a single deposit: insert to DB and credit user balance
     */
    async processDeposit(deposit, asset, userAddress) {
        if (!this.chainConfig) {
            throw new Error('Chain config not loaded');
        }
        try {
            // Check if deposit already exists (idempotency)
            const { data: existingDeposit, error: checkError } = await this.supabase
                .from('deposits')
                .select('id')
                .eq('tx_hash', deposit.txHash)
                .eq('log_index', deposit.logIndex)
                .maybeSingle();
            if (checkError) {
                logger.error({ error: checkError.message, txHash: deposit.txHash }, 'Error checking for existing deposit');
                throw new Error(`Failed to check existing deposit: ${checkError.message}`);
            }
            if (existingDeposit) {
                logger.debug({ txHash: deposit.txHash, logIndex: deposit.logIndex }, 'Deposit already processed, skipping');
                return;
            }
            // Calculate human-readable amount
            const amountHuman = TronTRC20TransferParser.calculateHumanAmount(deposit.amountRaw, asset.decimals);
            // Insert deposit with PENDING status (confirmation worker will handle crediting)
            const { error: depositError } = await this.supabase
                .from('deposits')
                .insert({
                chain_id: this.chainConfig.id,
                asset_on_chain_id: asset.id,
                tx_hash: deposit.txHash,
                log_index: deposit.logIndex,
                from_address: deposit.from,
                to_address: deposit.to,
                amount_raw: deposit.amountRaw,
                amount_human: amountHuman,
                block_number: deposit.blockNumber,
                block_timestamp: deposit.blockTimestamp.toISOString(),
                status: 'pending',
                confirmations: 0,
                first_seen_block: deposit.blockNumber,
            });
            if (depositError) {
                // Check if it's a unique constraint violation (race condition)
                if (depositError.code === '23505') {
                    logger.debug({ txHash: deposit.txHash, logIndex: deposit.logIndex }, 'Deposit inserted by another worker instance, skipping');
                    return;
                }
                throw new Error(`Failed to insert deposit: ${depositError.message}`);
            }
            logger.info({
                txHash: deposit.txHash,
                toAddress: deposit.to,
                amount: amountHuman,
                asset: asset.contract_address,
                blockNumber: deposit.blockNumber,
                status: 'pending',
            }, 'Deposit detected and recorded as PENDING');
        }
        catch (error) {
            logger.error({
                error: error.message,
                txHash: deposit.txHash,
                logIndex: deposit.logIndex,
            }, 'Error processing deposit');
            throw error;
        }
    }
    /**
     * REMOVED: Balance crediting is now handled by separate confirmation worker
     * This deposit listener only detects and records deposits as PENDING
     */
    /**
     * Start the worker loop
     */
    async start() {
        if (this.isRunning || !this.runtime) {
            if (!this.runtime)
                logger.warn('Worker not initialized');
            else if (this.isRunning)
                logger.warn('Worker is already running');
            return;
        }
        this.isRunning = true;
        this.stopHeartbeat = this.runtime.startHeartbeat(defaultHeartbeatIntervalMs());
        logger.info('Starting TRON deposit worker loop');
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
                    await sleep(env.worker.scanIntervalMs);
                    continue;
                }
                await this.scanDeposits();
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
            await sleep(env.worker.scanIntervalMs);
        }
        this.stopHeartbeat?.();
        await this.runtime.setStopped();
    }
    /**
     * Stop the worker loop
     */
    stop() {
        logger.info('Stopping TRON deposit worker');
        this.isRunning = false;
    }
    /**
     * Reload configuration and user addresses
     */
    async reload() {
        logger.info('Reloading worker configuration');
        await this.loadActiveAssets();
        await this.loadUserAddresses();
        logger.info('Worker configuration reloaded');
    }
}
//# sourceMappingURL=tron.deposit.worker.js.map
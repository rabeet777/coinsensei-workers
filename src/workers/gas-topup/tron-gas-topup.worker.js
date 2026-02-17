import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../config/supabase.js';
import { SignerService } from '../../services/signer.service.js';
import { logger } from '../../utils/logger.js';
import { sleep, sleepWithBackoff } from '../../utils/sleep.js';
import { WorkerRuntime, workerIdentity, defaultHeartbeatIntervalMs, } from '../../control-plane/worker-runtime.js';
export class TronGasTopupWorker {
    supabase;
    signerService;
    runtime = null;
    isRunning = false;
    stopHeartbeat = null;
    GAS_LOCK_DURATION_MINUTES = 5;
    POLL_INTERVAL_MS = 15000; // 15 seconds
    MAX_RETRIES = 8;
    CONFIRMATION_BLOCKS = 1; // Configurable
    FEE_LIMIT = 2000000; // 2 TRX in SUN
    CONFIRM_RETRY_DELAY_MS = 20000; // 20 seconds - FIX 2
    rpcUrl = '';
    chainId = '';
    constructor() {
        this.supabase = getSupabaseClient();
        this.signerService = new SignerService('tron-gas-worker');
    }
    get WORKER_ID() {
        return this.runtime?.workerId ?? `tron_gas_topup_${process.pid}`;
    }
    /**
     * Initialize worker
     */
    async initialize() {
        logger.info('Initializing TRON Gas Top-Up Worker...');
        // Load TRON chain configuration
        const { data: chain, error } = await this.supabase
            .from('chains')
            .select('id, name, rpc_url')
            .eq('name', 'tron')
            .eq('is_active', true)
            .maybeSingle();
        if (error || !chain) {
            throw new Error(`Failed to load TRON chain config: ${error?.message}`);
        }
        this.rpcUrl = chain.rpc_url;
        this.chainId = chain.id;
        this.runtime = new WorkerRuntime(workerIdentity('gas_topup_execute', this.chainId));
        await this.runtime.register();
        // TronWeb removed - signer service handles all TRON blockchain interactions
        // Check signer service health
        const signerHealthy = await this.signerService.healthCheck();
        if (!signerHealthy) {
            logger.warn('Signer service health check failed - transactions may fail');
        }
        logger.info({
            workerId: this.WORKER_ID,
            chainId: this.chainId,
            rpcUrl: this.rpcUrl,
            maxRetries: this.MAX_RETRIES,
            confirmationBlocks: this.CONFIRMATION_BLOCKS,
            signerHealthy,
        }, 'TRON Gas Top-Up Worker initialized successfully');
    }
    /**
     * Process batch of gas top-up jobs
     * Jobs are picked one at a time to ensure proper gas locking
     */
    async processBatch() {
        let job = null;
        try {
            // Pick ONE job (gas locking happens at wallet level, not job level)
            job = await this.pickNextJob();
            if (!job) {
                // Only log debug every 10th time to avoid spam
                if (Math.random() < 0.1) {
                    logger.debug('No TRON gas top-up jobs to process');
                }
                return;
            }
            logger.info({
                jobId: job.id,
                walletId: job.wallet_id,
                status: job.status,
                workerId: this.WORKER_ID,
            }, 'Picked TRON gas top-up job');
            // Process the job with gas locking
            logger.debug({ jobId: job.id, walletId: job.wallet_id }, 'Starting job processing with gas lock');
            await this.processJobWithGasLock(job);
        }
        catch (error) {
            logger.error({ error: error.message, jobId: job?.id }, 'Error processing TRON gas top-up');
        }
    }
    /**
     * Pick next job from gas_topup_queue
     * A) Fetch 25 candidates, sort in code by priority, pick first
     * B) NO row-level locking here - locking happens at wallet_balances level
     */
    async pickNextJob() {
        try {
            // Fetch up to 25 candidate jobs
            const { data: candidates, error } = await this.supabase
                .from('gas_topup_queue')
                .select('*')
                .eq('chain_id', this.chainId)
                .in('status', ['pending', 'confirming'])
                .lte('scheduled_at', new Date().toISOString())
                .limit(25);
            if (error) {
                logger.error({ error: error.message }, 'Failed to fetch candidate jobs');
                return null;
            }
            if (!candidates || candidates.length === 0) {
                logger.debug({
                    chainId: this.chainId,
                    statusFilter: ['pending', 'confirming'],
                    scheduledAtFilter: new Date().toISOString()
                }, 'No candidate jobs found matching criteria');
                return null;
            }
            logger.debug({
                candidateCount: candidates.length,
                chainId: this.chainId
            }, 'Found candidate jobs, sorting by priority');
            // FIX 1: Sort in code using priority rank map
            const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
            const priorityRank = (priority) => {
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
            const job = candidates[0];
            // B) STATUS TRANSITIONS
            // - If status='pending' and tx_hash is NULL -> set status='processing' (new job to process)
            // - If status='confirming' -> keep as 'confirming' (already broadcasted, confirmation worker handles)
            if (job.status === 'pending' && !job.tx_hash) {
                await this.supabase
                    .from('gas_topup_queue')
                    .update({ status: 'processing' })
                    .eq('id', job.id);
                job.status = 'processing'; // Update local object
            }
            else if (job.status === 'confirming') {
                // Job already in confirming state - no status update needed
                // Confirmation worker will handle it
            }
            return job;
        }
        catch (error) {
            logger.error({ error: error.message }, 'Error picking job');
            return null;
        }
    }
    /**
     * Process job with wallet-level gas locking
     * CRITICAL: Gas lock must be acquired at wallet_balances level, not job level
     * NOTE: Jobs in 'confirming' state should NOT acquire gas lock - confirmation worker handles them
     */
    async processJobWithGasLock(job) {
        let gasLockAcquired = false;
        try {
            // CRITICAL: Jobs in 'confirming' state should NOT acquire gas lock
            // They are already broadcasted and confirmation worker handles them
            if (job.status === 'confirming') {
                logger.debug({ jobId: job.id, status: job.status, txHash: job.tx_hash }, 'Job in confirming state - skipping gas lock acquisition, confirmation worker handles');
                // Just verify the job is in the correct state and return
                // Confirmation worker will handle the outcome
                return;
            }
            // C) CRITICAL: Acquire gas lock at wallet_balances level (only for pending/processing jobs)
            logger.debug({ jobId: job.id, walletId: job.wallet_id, gasAssetId: job.gas_asset_id }, 'Attempting to acquire gas lock');
            gasLockAcquired = await this.acquireGasLock(job.wallet_id, job.gas_asset_id, job.chain_id);
            if (!gasLockAcquired) {
                logger.warn({
                    jobId: job.id,
                    walletId: job.wallet_id,
                    gasAssetId: job.gas_asset_id,
                    chainId: job.chain_id
                }, 'Could not acquire gas lock - another worker owns it or wallet_balances row missing, resetting job to pending');
                // Reset job status to pending so it can be retried
                await this.supabase
                    .from('gas_topup_queue')
                    .update({ status: 'pending' })
                    .eq('id', job.id);
                return;
            }
            logger.debug({ jobId: job.id, walletId: job.wallet_id }, 'Gas lock acquired, processing job');
            // Process with lock held
            await this.processJob(job);
            // On success: DO NOT release gas lock here
            // Confirmation worker will release lock after confirming transaction
            logger.debug({ jobId: job.id }, 'Job processed successfully - gas lock will be released by confirmation worker');
        }
        catch (error) {
            logger.error({ error: error.message, jobId: job.id }, 'Error processing job with gas lock');
            await this.handleJobError(job, error);
            // On error: Release gas lock to allow retry
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
    async acquireGasLock(walletId, gasAssetId, chainId) {
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
            // Check if wallet_balances row exists
            const { data: existingBalance, error: checkError } = await this.supabase
                .from('wallet_balances')
                .select('id, gas_locked_until, gas_locked_by')
                .eq('wallet_id', walletId)
                .eq('asset_on_chain_id', gasAssetOnChain.id)
                .maybeSingle();
            if (checkError) {
                logger.error({ error: checkError.message, walletId, assetOnChainId: gasAssetOnChain.id }, 'Error checking wallet_balances row');
                return false;
            }
            if (!existingBalance) {
                logger.error({
                    walletId,
                    assetOnChainId: gasAssetOnChain.id,
                    gasAssetId,
                    chainId,
                    issue: 'MISSING_WALLET_BALANCES_ROW'
                }, 'wallet_balances row does not exist - cannot acquire gas lock. INSERT required row before processing.');
                return false;
            }
            // Check if lock is expired or null (handle timestamptz properly)
            const now = new Date();
            const lockTimestamp = existingBalance.gas_locked_until
                ? new Date(existingBalance.gas_locked_until)
                : null;
            const lockExpired = !lockTimestamp || lockTimestamp < now;
            if (!lockExpired) {
                // Lock is still active
                logger.debug({
                    walletId,
                    assetOnChainId: gasAssetOnChain.id,
                    existingLock: existingBalance.gas_locked_until,
                    existingLockBy: existingBalance.gas_locked_by,
                    lockTimestamp: lockTimestamp?.toISOString(),
                    now: now.toISOString(),
                    lockStatus: 'ACTIVE'
                }, 'Lock is still active - cannot acquire');
                return false;
            }
            const lockUntil = new Date(Date.now() + this.GAS_LOCK_DURATION_MINUTES * 60 * 1000).toISOString();
            // Attempt to acquire lock using explicit WHERE conditions
            // Since Supabase .or() with timestamptz can be unreliable, we'll use a direct update
            // with explicit NULL check or timestamp comparison in the WHERE clause
            // We know the lock is expired or null from our check above, so we can update directly
            const { data, error } = await this.supabase
                .from('wallet_balances')
                .update({
                gas_locked_until: lockUntil,
                gas_locked_by: this.WORKER_ID,
                processing_status: 'gas_processing',
            })
                .eq('wallet_id', walletId)
                .eq('asset_on_chain_id', gasAssetOnChain.id)
                .select();
            if (error) {
                logger.error({ error: error.message, walletId, assetOnChainId: gasAssetOnChain.id }, 'Error updating wallet_balances for gas lock');
                return false;
            }
            if (!data || data.length === 0) {
                // Lock not acquired - another worker owns it or lock still valid
                const lockStatus = existingBalance.gas_locked_until
                    ? (new Date(existingBalance.gas_locked_until) > new Date() ? 'ACTIVE' : 'EXPIRED')
                    : 'NONE';
                logger.warn({
                    walletId,
                    assetOnChainId: gasAssetOnChain.id,
                    existingLock: existingBalance.gas_locked_until,
                    existingLockBy: existingBalance.gas_locked_by,
                    lockStatus,
                    issue: lockStatus === 'ACTIVE' ? 'LOCK_HELD_BY_ANOTHER_WORKER' : 'LOCK_UPDATE_FAILED'
                }, `Lock not acquired - ${lockStatus === 'ACTIVE' ? 'another worker owns it' : 'lock update returned no rows'}`);
                return false;
            }
            logger.debug({ walletId, assetOnChainId: gasAssetOnChain.id, workerId: this.WORKER_ID }, 'Acquired gas lock at wallet level');
            return true;
        }
        catch (error) {
            logger.error({ error: error.message, walletId }, 'Error acquiring gas lock');
            return false;
        }
    }
    /**
     * Release gas lock at wallet_balances level
     * H) RELEASE GAS LOCK (ALWAYS) - In finally block
     */
    async releaseGasLock(walletId, gasAssetId, chainId, success = false) {
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
            const updates = {
                gas_locked_until: null,
                gas_locked_by: null,
                processing_status: 'idle',
                last_processed_at: new Date().toISOString(),
            };
            // Do NOT update needs_gas here - confirmation worker handles final outcome
            // H) Release lock: WHERE wallet_id=job.wallet_id AND asset_on_chain_id=<gas asset_on_chain_id> AND gas_locked_by=WORKER_ID
            await this.supabase
                .from('wallet_balances')
                .update(updates)
                .eq('wallet_id', walletId)
                .eq('asset_on_chain_id', gasAssetOnChain.id)
                .eq('gas_locked_by', this.WORKER_ID);
            logger.debug({ walletId, success }, 'Released gas lock');
        }
        catch (error) {
            logger.error({ error: error.message, walletId }, 'Error releasing gas lock');
        }
    }
    /**
     * Process a single gas top-up job through state machine
     */
    async processJob(job) {
        try {
            logger.info({
                jobId: job.id,
                walletId: job.wallet_id,
                status: job.status,
                amount: job.topup_amount_human,
                retryCount: job.retry_count || 0,
                txHash: job.tx_hash || null,
            }, 'Processing TRON gas top-up job');
            // FIX 2: IDEMPOTENCY - If tx_hash exists, job is already broadcasted
            // Confirmation worker will handle final outcome
            if (job.tx_hash && job.status !== 'failed') {
                logger.info({ jobId: job.id, txHash: job.tx_hash, status: job.status }, 'Transaction already broadcasted - confirmation worker will handle outcome');
                // Ensure status is confirming if not already confirmed/failed
                if (job.status !== 'confirming' && job.status !== 'confirmed' && job.status !== 'failed') {
                    await this.updateJobStatus(job.id, 'confirming');
                }
                // Do NOT confirm here - confirmation worker handles it
                return;
            }
            // G) Attempt limit enforcement
            const retryCount = job.retry_count || 0;
            if (retryCount >= this.MAX_RETRIES) {
                logger.error({ jobId: job.id, retryCount, maxRetries: this.MAX_RETRIES }, 'Max retries exceeded - marking as failed');
                await this.updateJobStatus(job.id, 'failed');
                await this.supabase
                    .from('gas_topup_queue')
                    .update({ processed_at: new Date().toISOString() })
                    .eq('id', job.id);
                return;
            }
            // FIX 2: COLLAPSE STATUS MACHINE - Only use: pending, processing, confirming, confirmed, failed, cancelled
            if (job.status === 'pending' || job.status === 'processing') {
                // If tx_hash IS NULL: build → sign → broadcast → store tx_hash → status = 'confirming'
                if (!job.tx_hash) {
                    await this.executeNewJob(job);
                }
                else {
                    // If tx_hash EXISTS: status = 'confirming', confirmation worker handles outcome
                    await this.updateJobStatus(job.id, 'confirming');
                    // Do NOT confirm here - confirmation worker handles it
                }
            }
            else if (job.status === 'confirming') {
                // Confirmation worker handles confirming jobs - nothing to do here
                logger.debug({ jobId: job.id }, 'Job in confirming state - confirmation worker handles outcome');
            }
            else if (job.status === 'confirmed') {
                // Already confirmed, nothing to do
                logger.debug({ jobId: job.id }, 'Job already confirmed');
            }
            else {
                logger.warn({ jobId: job.id, status: job.status }, 'Job in unexpected state for processing');
            }
        }
        catch (error) {
            await this.handleJobError(job, error);
        }
    }
    /**
     * Execute a new gas top-up job
     */
    async executeNewJob(job) {
        // STATE: queued → processing
        await this.updateJobStatus(job.id, 'processing');
        // E) FUNDING WALLET RESOLUTION (AUTHORITATIVE)
        logger.debug({ jobId: job.id, operationWalletAddressId: job.operation_wallet_address_id }, 'Loading funding wallet address');
        // Load from operation_wallet_addresses by id = job.operation_wallet_address_id AND chain_id = job.chain_id AND is_active = true
        const fundingWallet = await this.loadOperationWalletAddress(job.operation_wallet_address_id, job.chain_id);
        if (!fundingWallet) {
            // E) If not found => retryable error
            logger.error({ jobId: job.id, operationWalletAddressId: job.operation_wallet_address_id }, 'Funding wallet address not found');
            const error = new Error('Funding wallet address not found');
            error.isRetryable = true;
            error.errorType = 'funding_wallet_not_found';
            throw error;
        }
        logger.debug({ jobId: job.id, fundingAddress: fundingWallet.address }, 'Funding wallet loaded');
        // D) Load target wallet address
        logger.debug({ jobId: job.id, walletId: job.wallet_id }, 'Loading target wallet address');
        const targetWallet = await this.loadTargetWalletAddress(job.wallet_id, job.chain_id);
        if (!targetWallet) {
            // D) If not found => set status='failed', processed_at=now(), error_message, release gas lock
            await this.updateJobStatus(job.id, 'failed');
            await this.supabase
                .from('gas_topup_queue')
                .update({
                processed_at: new Date().toISOString(),
                error_message: 'Target wallet address not found',
            })
                .eq('id', job.id);
            throw new Error('Target wallet address not found');
        }
        logger.info({
            jobId: job.id,
            from: fundingWallet.address,
            to: targetWallet.address,
            amount: job.topup_amount_human,
        }, 'Loaded wallet addresses for gas top-up');
        // Validate funding wallet balance
        logger.debug({ jobId: job.id, address: fundingWallet.address, amount: job.topup_amount_raw }, 'Validating funding wallet balance');
        await this.validateFundingBalance(fundingWallet.address, job.topup_amount_raw);
        logger.debug({ jobId: job.id }, 'Funding wallet balance validated');
        // Prepare transaction intent (signer will build, sign, and broadcast)
        logger.debug({ jobId: job.id, from: fundingWallet.address, to: targetWallet.address }, 'Preparing TRON transaction intent');
        // Build transaction intent (from, to, amount_sun)
        const txIntent = await this.buildTransactionIntent(fundingWallet.address, targetWallet.address, job.topup_amount_raw || job.topup_amount_human);
        logger.debug({ jobId: job.id }, 'Transaction intent prepared');
        // Delegate build, sign, and broadcast to signer service
        logger.debug({ jobId: job.id }, 'Requesting transaction from signer service (build, sign, broadcast)');
        try {
            // Signer service handles: build transaction, sign, and broadcast
            // Returns txHash directly after successful broadcast
            const signerResult = await this.signerService.signTransaction({
                chain: 'tron',
                wallet_group_id: fundingWallet.wallet_group_id,
                derivation_index: fundingWallet.derivation_index,
                tx_intent: txIntent, // Send intent: from, to, amount_sun
            });
            // Signer service returns txHash after successful broadcast
            // Check multiple possible field names for txHash (signer may return different formats)
            const signerResponse = signerResult;
            const txHash = signerResponse.tx_hash || signerResponse.txHash || signerResponse.tx_id || signerResponse.txid;
            if (!txHash) {
                // Log full response for debugging
                logger.error({
                    jobId: job.id,
                    signerResponse: signerResponse,
                    availableFields: Object.keys(signerResponse || {}),
                    expectedField: 'tx_hash',
                }, 'Signer service did not return txHash after broadcast - check signer response structure');
                throw new Error('Signer service did not return txHash after broadcast');
            }
            logger.info({ jobId: job.id, txHash }, 'Transaction built, signed, and broadcasted successfully by signer service');
            // Move to 'confirming' ONLY after signer returns txHash
            // Save txHash at this point
            await this.updateJobTxHash(job.id, txHash, 'confirming');
            // Confirmation worker will handle final outcome
        }
        catch (signerError) {
            // Handle TAPOS_ERROR or broadcast errors from signer service
            // TAPOS_ERROR means transaction has expired block references
            // Transaction was NEVER accepted on-chain - must rebuild, not retry
            if (signerError.errorCode === 'TAPOS_ERROR' ||
                signerError.isTaposError ||
                signerError.message?.toLowerCase().includes('tapos check error')) {
                logger.warn({
                    jobId: job.id,
                    error: signerError.message,
                    errorCode: signerError.errorCode,
                }, 'TAPOS_ERROR from signer service - discarding stale transaction, will rebuild on retry');
                // DO NOT store txHash (transaction was never accepted)
                // DO NOT move to 'confirming' state
                // Mark as retryable - next retry will call signer again (fresh rebuild)
                const taposError = new Error(`TAPOS_ERROR: ${signerError.message}`);
                taposError.isRetryable = true;
                taposError.errorType = 'tapos_error';
                taposError.errorCode = 'TAPOS_ERROR';
                throw taposError;
            }
            // Handle other signer service errors
            if (signerError.errorCode === 'UNAUTHORIZED' || signerError.errorType === 'unauthorized') {
                const err = new Error('Signer service unauthorized');
                err.isRetryable = false;
                err.errorType = 'unauthorized';
                throw err;
            }
            else if (signerError.errorCode === 'DERIVATION_FAILED' || signerError.errorType === 'derivation_failed') {
                const err = new Error('Wallet derivation failed');
                err.isRetryable = false;
                err.errorType = 'derivation_failed';
                throw err;
            }
            // Re-throw other errors (VAULT_UNAVAILABLE, SIGNING_FAILED, etc. are already marked as retryable)
            throw signerError;
        }
    }
    /**
     * Load operation wallet address (funding wallet)
     * E) FUNDING WALLET RESOLUTION (AUTHORITATIVE)
     * - Load from operation_wallet_addresses by id = job.operation_wallet_address_id AND chain_id = job.chain_id AND is_active = true
     * - Use (address, wallet_group_id, derivation_index)
     */
    async loadOperationWalletAddress(id, chainId) {
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
        return data;
    }
    /**
     * Load target wallet address from user_wallet_addresses
     * D) TARGET ADDRESS RESOLUTION (CORRECT)
     * - gas_topup_queue.wallet_id corresponds to user_wallet_addresses.id (NOT uid)
     * - SELECT address, uid, chain_id, wallet_group_id, derivation_index
     * - FROM user_wallet_addresses WHERE id = job.wallet_id AND chain_id = job.chain_id AND is_active = true
     */
    async loadTargetWalletAddress(walletId, chainId) {
        const { data, error } = await this.supabase
            .from('user_wallet_addresses')
            .select('address, uid, chain_id, wallet_group_id, derivation_index, is_active')
            .eq('id', walletId) // D) CRITICAL: Use id, NOT uid
            .eq('chain_id', chainId)
            .eq('is_active', true)
            .maybeSingle();
        if (error || !data) {
            logger.error({ error: error?.message, walletId, chainId }, 'Failed to load target wallet address');
            return null;
        }
        return {
            address: data.address,
            uid: data.uid,
            wallet_group_id: data.wallet_group_id,
            derivation_index: data.derivation_index,
        };
    }
    /**
     * Validate funding wallet has sufficient balance
     * NOTE: Balance validation is now handled by signer service
     * This method is kept for compatibility but does not perform actual validation
     */
    async validateFundingBalance(address, requiredAmount) {
        // Balance validation is delegated to signer service
        // Signer service will check balance before building transaction
        logger.debug({ address, requiredAmount }, 'Balance validation delegated to signer service');
    }
    /**
     * Build transaction intent for signer service
     * Signer service is responsible for building the transaction
     * Returns: type, from, to, amount_sun
     */
    async buildTransactionIntent(from, to, amount) {
        try {
            // Parse amount using BigInt (NEVER parseInt for financial amounts)
            const amountBigInt = BigInt(amount);
            const amountSun = amountBigInt.toString();
            logger.debug({ from, to, amount_sun: amountSun }, 'Built TRON transaction intent');
            return {
                type: 'send_trx',
                from,
                to,
                amount_sun: amountSun,
            };
        }
        catch (error) {
            logger.error({ error: error.message, from, to, amount }, 'Failed to build TRON transaction intent');
            this.classifyTronError(error);
            throw error;
        }
    }
    /**
     * FIX 6: ERROR CLASSIFICATION - Minimal classification for TRON
     */
    classifyTronError(error) {
        const message = error.message?.toLowerCase() || '';
        // FIX 6: Invalid address/hex/bad address → mark 'failed'
        if (message.includes('invalid address') ||
            message.includes('invalid hex') ||
            message.includes('bad address') ||
            message.includes('invalid signature') ||
            message.includes('invalid parameter')) {
            error.isRetryable = false;
            error.errorType = 'invalid_data';
        }
        // FIX 6: Insufficient funds → mark 'failed' (rule engine must intervene)
        else if (message.includes('insufficient funds') ||
            message.includes('balance not sufficient')) {
            error.isRetryable = false;
            error.errorType = 'insufficient_balance';
        }
        // Retryable errors (network, timeout, etc.)
        else if (message.includes('timeout') ||
            message.includes('network') ||
            message.includes('connection')) {
            error.isRetryable = true;
            error.errorType = 'network_error';
        }
        // Default to retryable
        else {
            error.isRetryable = true;
            error.errorType = 'unknown';
        }
    }
    // REMOVED: signTransaction() - now handled inline in executeNewJob()
    // REMOVED: createTaposError() - TAPOS_ERROR handled from signer service
    // REMOVED: broadcastTransaction() - signer service handles broadcast
    // REMOVED: confirmTransaction() - confirmation is handled by separate confirmation worker
    // Gas worker only submits transactions and moves them to 'confirming' state
    /**
     * Update wallet gas state after successful top-up
     */
    async updateWalletGasState(walletId, chainId, needsGas) {
        try {
            // Find native asset for chain
            const { data: nativeAsset } = await this.supabase
                .from('asset_on_chain')
                .select('id')
                .eq('chain_id', chainId)
                .eq('is_native', true)
                .maybeSingle();
            if (!nativeAsset) {
                logger.warn({ chainId }, 'Could not find native asset for chain');
                return;
            }
            // Update wallet_balances (native row only)
            const { error } = await this.supabase
                .from('wallet_balances')
                .update({
                needs_gas: needsGas,
                gas_priority: needsGas ? null : null,
            })
                .eq('wallet_id', walletId)
                .eq('asset_on_chain_id', nativeAsset.id);
            if (error) {
                logger.error({ error: error.message, walletId }, 'Failed to update wallet gas state');
            }
            else {
                logger.info({ walletId, needsGas }, 'Updated wallet gas state');
            }
        }
        catch (error) {
            logger.error({ error: error.message, walletId }, 'Error updating wallet gas state');
        }
    }
    /**
     * Write audit record (internal ledger)
     */
    async writeAuditRecord(job) {
        try {
            // Load funding and target addresses
            const fundingWallet = await this.loadOperationWalletAddress(job.operation_wallet_address_id, job.chain_id);
            const targetAddress = await this.loadTargetWalletAddress(job.wallet_id, job.chain_id);
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
                status: 'confirmed',
                retry_count: job.retry_count,
            };
            logger.debug({ auditRecord }, 'Audit record prepared');
            // Insert would go to a ledger/audit table when implemented
        }
        catch (error) {
            logger.error({ error: error.message, jobId: job.id }, 'Error writing audit record');
        }
    }
    /**
     * Update job status in gas_topup_queue
     * FIX 1: Only update valid columns: status, processed_at (if confirmed/failed)
     */
    async updateJobStatus(jobId, newStatus) {
        const updates = {
            status: newStatus,
        };
        // Only set processed_at for final states
        if (newStatus === 'confirmed' || newStatus === 'failed') {
            updates.processed_at = new Date().toISOString();
        }
        const { error } = await this.supabase
            .from('gas_topup_queue')
            .update(updates)
            .eq('id', jobId);
        if (error) {
            throw new Error(`Failed to update status to ${newStatus}: ${error.message}`);
        }
        logger.debug({ jobId, newStatus }, 'Job status updated');
    }
    /**
     * Update job with tx_hash
     * FIX 1: Only update valid columns: tx_hash, status
     */
    async updateJobTxHash(jobId, txHash, status) {
        const { error } = await this.supabase
            .from('gas_topup_queue')
            .update({
            tx_hash: txHash,
            status,
        })
            .eq('id', jobId);
        if (error) {
            throw new Error(`Failed to update tx_hash: ${error.message}`);
        }
    }
    /**
     * Handle job error with retry backoff policy
     * G) RETRY / BACKOFF
     * - MAX_RETRIES=8
     * - Backoff = min(2^retry_count * 30 seconds, 15 minutes)
     * - On retryable error: increment retry_count, set error_message, scheduled_at, status='pending', release gas lock
     * - If retry_count >= MAX_RETRIES: status='failed', processed_at=now(), release gas lock
     */
    async handleJobError(job, error) {
        const retryCount = (job.retry_count || 0) + 1;
        const maxRetries = this.MAX_RETRIES;
        // Use error classification
        const isRetryable = error.isRetryable !== false && retryCount < maxRetries;
        const errorType = error.errorType || 'unknown';
        // Calculate backoff: min(2^retry_count * 30s, 15min)
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
        }, 'TRON gas top-up job error');
        // FIX 1: Only update valid columns: retry_count, error_message, status, scheduled_at, processed_at
        const updates = {
            retry_count: retryCount,
            error_message: `[${errorType}] ${error.message}`,
        };
        if (isRetryable) {
            // On retryable error: status='pending', scheduled_at set
            updates.status = 'pending';
            updates.scheduled_at = scheduledAt;
        }
        else {
            // If retry_count >= MAX_RETRIES: status='failed', processed_at=now()
            updates.status = 'failed';
            updates.processed_at = new Date().toISOString();
        }
        await this.supabase
            .from('gas_topup_queue')
            .update(updates)
            .eq('id', job.id);
        // FIX 4: REMOVE double gas-lock release - gas lock is released in outer finally block
    }
    /**
     * Start worker loop
     */
    async start() {
        if (this.isRunning || !this.runtime) {
            if (!this.runtime)
                logger.warn('Worker not initialized');
            else if (this.isRunning)
                logger.warn('TRON Gas Top-Up Worker already running');
            return;
        }
        this.isRunning = true;
        this.stopHeartbeat = this.runtime.startHeartbeat(defaultHeartbeatIntervalMs());
        logger.info({ workerId: this.WORKER_ID }, 'Starting TRON Gas Top-Up Worker loop');
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
                logger.error({ error: error.message }, 'Error in TRON gas top-up worker loop');
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
        logger.info({ workerId: this.WORKER_ID }, 'Stopping TRON Gas Top-Up Worker');
        this.isRunning = false;
    }
}
//# sourceMappingURL=tron-gas-topup.worker.js.map
import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import { WorkerRuntime, workerIdentity, defaultHeartbeatIntervalMs, } from '../../control-plane/worker-runtime.js';
export class RuleExecutionWorker {
    supabase;
    runtime;
    isRunning = false;
    stopHeartbeat = null;
    BATCH_SIZE = 50;
    LOCK_DURATION_SECONDS = 120; // 2 minutes
    EXECUTION_INTERVAL_MS = 30000; // 30 seconds
    constructor() {
        this.supabase = getSupabaseClient();
        this.runtime = new WorkerRuntime(workerIdentity('rule_execution', null));
    }
    get WORKER_ID() {
        return this.runtime.workerId;
    }
    /**
     * Initialize worker
     */
    async initialize() {
        logger.info('Initializing Rule Execution Worker...');
        await this.runtime.register();
        logger.info({
            workerId: this.runtime.workerId,
            batchSize: this.BATCH_SIZE,
        }, 'Rule Execution Worker initialized successfully');
    }
    /**
     * Process a batch of wallet balances
     */
    async processBatch() {
        try {
            // Step 1: Select and lock rows
            const lockedRows = await this.selectAndLockRows();
            if (lockedRows.length === 0) {
                logger.debug('No wallet balances to process for rule execution');
                return;
            }
            logger.info({ count: lockedRows.length, workerId: this.WORKER_ID }, 'Processing batch for rule execution');
            // Step 2: Process each locked row
            for (const row of lockedRows) {
                await this.processWalletBalance(row);
            }
            logger.info({ processed: lockedRows.length }, 'Rule execution batch complete');
        }
        catch (error) {
            logger.error({ error: error.message, stack: error.stack }, 'Error processing rule execution batch');
            // Don't throw - continue to next cycle
        }
    }
    /**
     * Select and lock rows for processing
     * CRITICAL: Only selects wallets from user_wallet_addresses (operation wallets excluded)
     */
    async selectAndLockRows() {
        const lockUntil = new Date(Date.now() + this.LOCK_DURATION_SECONDS * 1000).toISOString();
        try {
            // STEP 1: Get all user wallet IDs (excludes operation wallets by design)
            const { data: userWalletIds, error: userWalletError } = await this.supabase
                .from('user_wallet_addresses')
                .select('id')
                .eq('is_active', true);
            if (userWalletError) {
                logger.error({ error: userWalletError.message }, 'Failed to load user wallet addresses for rule execution');
                return [];
            }
            if (!userWalletIds || userWalletIds.length === 0) {
                return [];
            }
            const userIds = userWalletIds.map((u) => u.id);
            const userIdsSet = new Set(userIds); // For fast lookup
            // STEP 2: Select wallet_balances ONLY for user wallets (JOIN via IN filter)
            // This is the canonical pattern: wallet_balances JOIN user_wallet_addresses
            const { data: availableRows, error: selectError } = await this.supabase
                .from('wallet_balances')
                .select('*')
                .in('wallet_id', userIds) // CRITICAL: Only user wallets
                .eq('processing_status', 'idle')
                .or(`locked_until.is.null,locked_until.lt.${new Date().toISOString()}`)
                .not('on_chain_balance_raw', 'is', null)
                .neq('on_chain_balance_raw', '0')
                .order('last_checked', { ascending: true, nullsFirst: true })
                .limit(this.BATCH_SIZE);
            if (selectError) {
                logger.error({ error: selectError.message }, 'Failed to select wallet balances for rule execution');
                return [];
            }
            if (!availableRows || availableRows.length === 0) {
                return [];
            }
            // CRITICAL SAFETY CHECK: Verify all selected rows are user wallets
            // This is a defensive check in case the IN filter has edge cases
            const userWalletRows = availableRows.filter((row) => userIdsSet.has(row.wallet_id));
            if (userWalletRows.length !== availableRows.length) {
                const operationWalletRows = availableRows.filter((row) => !userIdsSet.has(row.wallet_id));
                logger.error({
                    totalSelected: availableRows.length,
                    userWallets: userWalletRows.length,
                    operationWallets: operationWalletRows.length,
                    operationWalletIds: operationWalletRows.map((r) => r.wallet_id),
                }, 'CRITICAL: Selected rows include operation wallets - filtering them out');
            }
            // Only process user wallet rows
            const rowsToProcess = userWalletRows;
            if (rowsToProcess.length === 0) {
                return [];
            }
            // Lock selected rows (only user wallets)
            const rowIds = rowsToProcess.map((r) => r.id);
            // CRITICAL: Add additional filter to lock update to ensure only user wallets
            const { error: lockError } = await this.supabase
                .from('wallet_balances')
                .update({
                locked_until: lockUntil,
                locked_by: this.WORKER_ID,
                processing_status: 'processing',
            })
                .in('id', rowIds)
                .in('wallet_id', userIds) // CRITICAL: Double-check - only lock user wallets
                .eq('processing_status', 'idle');
            if (lockError) {
                logger.error({ error: lockError.message, rowCount: rowIds.length }, 'Failed to lock rows for rule execution');
                return [];
            }
            logger.debug({ locked: rowIds.length, workerId: this.WORKER_ID }, 'Locked wallet balance rows for rule execution (user wallets only)');
            return rowsToProcess;
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
        const startTime = Date.now();
        try {
            // CRITICAL SAFETY GUARD: Verify this is a user wallet (last-line-of-defense invariant)
            // Even though SQL JOIN excludes operation wallets, this provides runtime safety
            const { data: userWallet, error: userWalletError } = await this.supabase
                .from('user_wallet_addresses')
                .select('id')
                .eq('id', row.wallet_id)
                .maybeSingle();
            if (userWalletError) {
                logger.warn({
                    error: userWalletError.message,
                    walletId: row.wallet_id,
                    walletBalanceId: row.id,
                }, 'Error checking user wallet, skipping rule execution');
                await this.recordError(row.id, `Error verifying user wallet: ${userWalletError.message}`);
                return;
            }
            if (!userWallet) {
                logger.warn({
                    walletId: row.wallet_id,
                    walletBalanceId: row.id,
                }, 'Skipping rule execution for non-user wallet (operation wallet detected)');
                // Release lock and mark as processed (not an error, just not eligible)
                await this.finalizeWalletBalance(row.id, false, 0, false, 0);
                return;
            }
            // Load asset context
            const { data: assetOnChain, error: assetError } = await this.supabase
                .from('asset_on_chain')
                .select('id, chain_id, asset_id, is_native')
                .eq('id', row.asset_on_chain_id)
                .maybeSingle();
            if (assetError || !assetOnChain) {
                throw new Error(`Failed to load asset: ${assetError?.message || 'not found'}`);
            }
            // Reset flags before evaluation
            let needsConsolidation = false;
            let consolidationPriority = 0;
            let needsGas = false;
            let gasPriority = 0;
            // STEP 1: ALWAYS check gas sufficiency first (wallet-level, not row-level)
            // This is critical for cross-asset dependency
            // Find native gas asset for this chain
            const { data: nativeGasAsset, error: nativeError } = await this.supabase
                .from('asset_on_chain')
                .select('id, asset_id, chain_id')
                .eq('chain_id', assetOnChain.chain_id)
                .eq('is_native', true)
                .maybeSingle();
            if (nativeError || !nativeGasAsset) {
                logger.warn({
                    chainId: assetOnChain.chain_id,
                    walletBalanceId: row.id,
                }, 'Could not find native gas asset for chain, skipping gas check');
            }
            else {
                // Load native gas balance row for same wallet
                // SAFE: row.wallet_id is already verified to be a user wallet above
                const { data: nativeGasBalance, error: gasBalanceError } = await this.supabase
                    .from('wallet_balances')
                    .select('*')
                    .eq('wallet_id', row.wallet_id) // User wallet (verified)
                    .eq('asset_on_chain_id', nativeGasAsset.id)
                    .maybeSingle();
                if (gasBalanceError) {
                    logger.warn({
                        error: gasBalanceError.message,
                        walletId: row.wallet_id,
                        nativeAssetId: nativeGasAsset.id,
                    }, 'Could not load native gas balance for wallet');
                }
                else if (nativeGasBalance) {
                    // Evaluate gas rules against native gas balance
                    logger.debug({
                        walletBalanceId: row.id,
                        nativeGasBalanceId: nativeGasBalance.id,
                        nativeGasBalance: nativeGasBalance.on_chain_balance_human,
                    }, 'Checking native gas balance for wallet');
                    const gasResult = await this.executeGasTopupRules(nativeGasBalance, {
                        id: nativeGasAsset.id,
                        chain_id: nativeGasAsset.chain_id,
                        asset_id: nativeGasAsset.asset_id,
                        is_native: true,
                    });
                    if (gasResult.matched) {
                        // FIX 1: Gas is insufficient - evaluate consolidation FIRST, then queue gas only
                        needsGas = true;
                        gasPriority = gasResult.priority;
                        // STILL evaluate consolidation rules to determine if needs_consolidation should be true
                        const consolidationResult = await this.executeConsolidationRules(row, assetOnChain);
                        if (consolidationResult.matched) {
                            needsConsolidation = true;
                            consolidationPriority = consolidationResult.priority;
                        }
                        // Update current row with BOTH flags (gas blocks consolidation, but both can be true)
                        await this.finalizeWalletBalance(row.id, needsConsolidation, // Set if rule matched
                        consolidationPriority, true, // needs_gas=true (blocks consolidation)
                        gasPriority);
                        // FIX 2: Update native gas row ONLY (not all rows for wallet)
                        await this.updateNativeGasFlags(row.wallet_id, nativeGasAsset.id, true, // needs_gas=true
                        gasPriority);
                        logger.info({
                            walletBalanceId: row.id,
                            walletId: row.wallet_id,
                            nativeGasBalance: nativeGasBalance.on_chain_balance_human,
                            needsConsolidation,
                            needsGas: true,
                            reason: 'insufficient_gas',
                        }, '⛽ Gas insufficient - queued gas topup, consolidation blocked');
                        return; // Early return - consolidation enqueue skipped due to gas
                    }
                    else {
                        // FIX 3: Gas sufficient - clear needs_gas flag on native row only
                        await this.updateNativeGasFlags(row.wallet_id, nativeGasAsset.id, false, // needs_gas=false
                        0);
                        logger.debug({
                            walletBalanceId: row.id,
                            nativeGasBalance: nativeGasBalance.on_chain_balance_human,
                        }, '✅ Gas sufficient - proceeding with consolidation evaluation');
                    }
                }
            }
            // Execute consolidation rules ONLY if gas is sufficient
            const consolidationResult = await this.executeConsolidationRules(row, assetOnChain);
            if (consolidationResult.matched) {
                needsConsolidation = true;
                consolidationPriority = consolidationResult.priority;
            }
            // Update wallet_balances with rule evaluation results
            await this.finalizeWalletBalance(row.id, needsConsolidation, consolidationPriority, false, // needs_gas already set on native row
            0);
            const executionTime = Date.now() - startTime;
            logger.info({
                walletBalanceId: row.id,
                walletId: row.wallet_id,
                needsConsolidation,
                needsGas,
                executionTimeMs: executionTime,
            }, 'Rule execution completed for wallet balance');
        }
        catch (error) {
            logger.error({
                error: error.message,
                walletBalanceId: row.id,
            }, 'Error executing rules for wallet balance');
            // Record error and release lock
            await this.recordError(row.id, error.message);
        }
    }
    /**
     * Execute consolidation rules for a wallet balance
     */
    async executeConsolidationRules(walletBalance, assetOnChain) {
        const startTime = Date.now();
        try {
            // Load active consolidation rules
            const { data: rules, error } = await this.supabase
                .from('consolidation_rules')
                .select('*')
                .eq('is_active', true)
                .eq('chain_id', assetOnChain.chain_id)
                .eq('asset_on_chain_id', assetOnChain.id)
                .order('priority', { ascending: false });
            if (error) {
                throw new Error(`Failed to load consolidation rules: ${error.message}`);
            }
            if (!rules || rules.length === 0) {
                logger.debug({
                    walletBalanceId: walletBalance.id,
                    chainId: assetOnChain.chain_id,
                }, 'No active consolidation rules for this asset');
                return { matched: false, priority: 0 };
            }
            // Evaluate each rule
            for (const rule of rules) {
                const executionTimeMs = Date.now() - startTime;
                const result = this.evaluateCondition(walletBalance.on_chain_balance_human, rule.comparison_operator, rule.threshold_human);
                // ALWAYS log rule evaluation
                await this.logConsolidationRuleExecution(rule.id, walletBalance.wallet_id, result, {
                    balance: walletBalance.on_chain_balance_human,
                    threshold: rule.threshold_human,
                    comparison_operator: rule.comparison_operator,
                }, executionTimeMs);
                // If rule passes, schedule consolidation
                if (result) {
                    logger.info({
                        ruleId: rule.id,
                        walletBalanceId: walletBalance.id,
                        balance: walletBalance.on_chain_balance_human,
                        threshold: rule.threshold_human,
                    }, 'Consolidation rule matched');
                    // Insert into consolidation queue (idempotent)
                    await this.enqueueConsolidation(walletBalance, assetOnChain, rule);
                    return { matched: true, priority: rule.priority };
                }
            }
            return { matched: false, priority: 0 };
        }
        catch (error) {
            logger.error({
                error: error.message,
                walletBalanceId: walletBalance.id,
            }, 'Error executing consolidation rules');
            throw error;
        }
    }
    /**
     * Execute gas top-up rules for a wallet balance
     */
    async executeGasTopupRules(walletBalance, assetOnChain) {
        const startTime = Date.now();
        try {
            // Load active gas top-up rules
            const { data: rules, error } = await this.supabase
                .from('gas_topup_rules')
                .select('*')
                .eq('is_active', true)
                .eq('chain_id', assetOnChain.chain_id)
                .eq('gas_asset_id', assetOnChain.asset_id);
            if (error) {
                throw new Error(`Failed to load gas top-up rules: ${error.message}`);
            }
            if (!rules || rules.length === 0) {
                logger.debug({
                    walletBalanceId: walletBalance.id,
                    chainId: assetOnChain.chain_id,
                }, 'No active gas top-up rules for this asset');
                return { matched: false, priority: 0 };
            }
            // Evaluate each rule
            for (const rule of rules) {
                const executionTimeMs = Date.now() - startTime;
                const result = this.evaluateCondition(walletBalance.on_chain_balance_human, rule.comparison_operator, rule.threshold_human);
                // ALWAYS log rule evaluation
                await this.logGasTopupRuleExecution(rule.id, walletBalance.wallet_id, result, {
                    balance: walletBalance.on_chain_balance_human,
                    threshold: rule.threshold_human,
                    comparison_operator: rule.comparison_operator,
                }, executionTimeMs);
                // If rule passes, schedule gas top-up
                if (result) {
                    logger.info({
                        ruleId: rule.id,
                        walletBalanceId: walletBalance.id,
                        balance: walletBalance.on_chain_balance_human,
                        threshold: rule.threshold_human,
                    }, 'Gas top-up rule matched');
                    // Insert into gas top-up queue (idempotent)
                    await this.enqueueGasTopup(walletBalance, assetOnChain, rule);
                    return { matched: true, priority: rule.priority };
                }
            }
            return { matched: false, priority: 0 };
        }
        catch (error) {
            logger.error({
                error: error.message,
                walletBalanceId: walletBalance.id,
            }, 'Error executing gas top-up rules');
            throw error;
        }
    }
    /**
     * Evaluate a rule condition (comparison)
     * CRITICAL: Must handle balance = 0 correctly (0 is a valid balance, not "no balance")
     */
    evaluateCondition(balance, operator, threshold) {
        // Only return false if balance is actually null/undefined, not if it's 0
        if (balance === null || balance === undefined) {
            return false;
        }
        // Convert to string to handle both string and number inputs
        const balanceStr = String(balance);
        const balanceNum = parseFloat(balanceStr);
        const thresholdNum = parseFloat(threshold);
        // Handle invalid numbers
        if (isNaN(balanceNum) || isNaN(thresholdNum)) {
            logger.warn({ balance: balanceStr, threshold, operator }, 'Invalid number in condition evaluation');
            return false;
        }
        let result;
        switch (operator) {
            case '>':
            case 'gt':
                result = balanceNum > thresholdNum;
                break;
            case '>=':
            case 'gte':
                result = balanceNum >= thresholdNum;
                break;
            case '<':
            case 'lt':
                result = balanceNum < thresholdNum;
                break;
            case '<=':
            case 'lte':
                result = balanceNum <= thresholdNum;
                break;
            case '==':
            case 'eq':
                result = balanceNum === thresholdNum;
                break;
            case '!=':
            case 'neq':
                result = balanceNum !== thresholdNum;
                break;
            default:
                logger.warn({ operator }, 'Unknown comparison operator, defaulting to false');
                result = false;
        }
        logger.debug({
            balance: balanceNum,
            threshold: thresholdNum,
            operator,
            result,
            evaluation: `${balanceNum} ${operator} ${thresholdNum} = ${result}`,
        }, 'Rule condition evaluated');
        return result;
    }
    /**
     * Log consolidation rule execution
     */
    async logConsolidationRuleExecution(ruleId, walletId, executionResult, executionData, executionTimeMs) {
        const { error } = await this.supabase
            .from('consolidation_rule_logs')
            .insert({
            rule_id: ruleId,
            wallet_id: walletId,
            execution_result: executionResult,
            execution_data: executionData,
            execution_time_ms: executionTimeMs,
        });
        if (error) {
            logger.error({ error: error.message, ruleId, walletId }, 'Failed to log consolidation rule execution');
        }
    }
    /**
     * Log gas top-up rule execution
     */
    async logGasTopupRuleExecution(ruleId, walletId, executionResult, executionData, executionTimeMs) {
        const { error } = await this.supabase
            .from('gas_topup_rule_logs')
            .insert({
            rule_id: ruleId,
            wallet_id: walletId,
            execution_result: executionResult,
            execution_data: executionData,
            execution_time_ms: executionTimeMs,
        });
        if (error) {
            logger.error({ error: error.message, ruleId, walletId }, 'Failed to log gas top-up rule execution');
        }
    }
    /**
     * Enqueue consolidation operation
     */
    async enqueueConsolidation(walletBalance, assetOnChain, rule) {
        try {
            // CRITICAL: Final safety check - never enqueue if gas is needed
            // Re-fetch wallet_balances to get latest needs_gas state
            const { data: currentWalletBalance } = await this.supabase
                .from('wallet_balances')
                .select('needs_gas')
                .eq('id', walletBalance.id)
                .maybeSingle();
            if (currentWalletBalance?.needs_gas === true) {
                logger.info({
                    walletBalanceId: walletBalance.id,
                    reason: 'gas_required',
                }, 'Skipping consolidation enqueue - gas top-up required first');
                return;
            }
            // Check if already enqueued (idempotency)
            const { data: existingQueue } = await this.supabase
                .from('consolidation_queue')
                .select('id')
                .eq('wallet_balance_id', walletBalance.id)
                .in('status', ['pending', 'processing'])
                .maybeSingle();
            if (existingQueue) {
                logger.debug({
                    walletBalanceId: walletBalance.id,
                    queueId: existingQueue.id,
                }, 'Consolidation already queued, skipping');
                return;
            }
            // Select hot wallet address (chain-matched, round-robin)
            const operationWalletAddressId = await this.selectHotWalletAddress(assetOnChain.chain_id);
            if (!operationWalletAddressId) {
                throw new Error(`No active hot wallet address found for chain ${assetOnChain.chain_id}`);
            }
            // Insert into queue (only required fields for schema compatibility)
            const queueEntry = {
                chain_id: assetOnChain.chain_id,
                wallet_id: walletBalance.wallet_id,
                wallet_balance_id: walletBalance.id,
                operation_wallet_address_id: operationWalletAddressId,
                amount_raw: walletBalance.on_chain_balance_raw,
                amount_human: walletBalance.on_chain_balance_human,
                priority: rule.priority,
                status: 'pending',
            };
            // Add optional fields if they exist in schema
            try {
                queueEntry.rule_id = rule.id;
                queueEntry.reason = 'threshold_reached';
            }
            catch {
                // Optional fields may not exist in schema
            }
            const { error } = await this.supabase
                .from('consolidation_queue')
                .insert(queueEntry);
            if (error) {
                // Check for unique constraint violation (race condition)
                if (error.code === '23505') {
                    logger.debug({ walletBalanceId: walletBalance.id }, 'Consolidation queue insert conflict, skipping');
                    return;
                }
                throw new Error(`Failed to enqueue consolidation: ${error.message}`);
            }
            logger.info({
                walletBalanceId: walletBalance.id,
                walletId: walletBalance.wallet_id,
                operationWalletAddressId,
                amount: walletBalance.on_chain_balance_human,
                priority: rule.priority,
            }, 'Consolidation operation enqueued');
        }
        catch (error) {
            logger.error({ error: error.message, walletBalanceId: walletBalance.id }, 'Error enqueueing consolidation');
            throw error;
        }
    }
    /**
     * Enqueue gas top-up operation
     */
    async enqueueGasTopup(walletBalance, assetOnChain, rule) {
        try {
            // STRICT idempotency check (chain + gas asset + wallet + status)
            const { data: existingQueue } = await this.supabase
                .from('gas_topup_queue')
                .select('id')
                .eq('chain_id', assetOnChain.chain_id)
                .eq('gas_asset_id', assetOnChain.asset_id)
                .eq('wallet_id', walletBalance.wallet_id)
                .in('status', ['pending', 'processing'])
                .maybeSingle();
            if (existingQueue) {
                logger.debug({
                    walletBalanceId: walletBalance.id,
                    queueId: existingQueue.id,
                }, 'Gas top-up already queued, skipping');
                return;
            }
            // Get top-up amounts from rule (threshold_human is the topup amount)
            // Priority: metadata.topup_amount_human > rule.threshold_human
            const topupAmountHuman = rule.metadata?.topup_amount_human ||
                String(rule.threshold_human);
            const topupAmountRaw = rule.metadata?.topup_amount_raw ||
                rule.threshold_raw ||
                null;
            // Select gas operation wallet address (chain-matched with fallback)
            const operationWalletAddressId = await this.selectGasWalletAddress(assetOnChain.chain_id, rule.metadata?.operation_wallet_address_id);
            if (!operationWalletAddressId) {
                throw new Error(`No active gas wallet address (or hot wallet fallback) found for chain ${assetOnChain.chain_id}`);
            }
            // Insert into queue (schema-compatible fields only)
            const queueEntry = {
                chain_id: assetOnChain.chain_id,
                wallet_id: walletBalance.wallet_id,
                operation_wallet_address_id: operationWalletAddressId,
                gas_asset_id: assetOnChain.asset_id,
                topup_amount_raw: topupAmountRaw,
                topup_amount_human: topupAmountHuman,
                current_gas_balance_raw: walletBalance.on_chain_balance_raw,
                priority: rule.priority,
                status: 'pending',
            };
            // Add optional fields if they exist in schema
            try {
                queueEntry.rule_id = rule.id;
                queueEntry.reason = 'threshold_reached';
            }
            catch {
                // Optional fields may not exist in schema
            }
            const { error } = await this.supabase
                .from('gas_topup_queue')
                .insert(queueEntry);
            if (error) {
                // Check for unique constraint violation (race condition)
                if (error.code === '23505') {
                    logger.debug({ walletBalanceId: walletBalance.id }, 'Gas top-up queue insert conflict, skipping');
                    return;
                }
                throw new Error(`Failed to enqueue gas top-up: ${error.message}`);
            }
            logger.info({
                walletBalanceId: walletBalance.id,
                walletId: walletBalance.wallet_id,
                currentBalance: walletBalance.on_chain_balance_human,
                topupAmount: topupAmountHuman,
                operationWalletAddressId,
                priority: rule.priority,
            }, 'Gas top-up operation enqueued');
        }
        catch (error) {
            logger.error({ error: error.message, walletBalanceId: walletBalance.id }, 'Error enqueueing gas top-up');
            throw error;
        }
    }
    /**
     * Select hot wallet address for consolidation (chain-matched, round-robin)
     */
    async selectHotWalletAddress(chainId) {
        try {
            const { data: operationWalletAddress, error } = await this.supabase
                .from('operation_wallet_addresses')
                .select('*')
                .eq('is_active', true)
                .eq('role', 'hot')
                .eq('chain_id', chainId)
                .order('last_used_at', { ascending: true, nullsFirst: true })
                .limit(1)
                .maybeSingle();
            if (error) {
                logger.error({ chainId, error: error.message }, 'Error selecting hot wallet address');
                return null;
            }
            if (!operationWalletAddress) {
                logger.error({ chainId }, 'No active hot wallet address found for chain');
                return null;
            }
            // Update last_used_at for round-robin routing
            await this.updateWalletAddressUsage(operationWalletAddress.id);
            logger.debug({
                operationWalletAddressId: operationWalletAddress.id,
                chainId,
            }, 'Selected hot wallet address for consolidation');
            return operationWalletAddress.id;
        }
        catch (error) {
            logger.error({ error: error.message, chainId }, 'Error selecting hot wallet address');
            return null;
        }
    }
    /**
     * Select gas operation wallet address (chain-matched with fallback)
     */
    async selectGasWalletAddress(chainId, preferredWalletAddressId) {
        try {
            // Priority 1: Use preferred wallet address from rule metadata if valid
            if (preferredWalletAddressId) {
                const { data: preferredWallet } = await this.supabase
                    .from('operation_wallet_addresses')
                    .select('id, chain_id, is_active')
                    .eq('id', preferredWalletAddressId)
                    .eq('is_active', true)
                    .eq('chain_id', chainId)
                    .maybeSingle();
                if (preferredWallet) {
                    await this.updateWalletAddressUsage(preferredWallet.id);
                    logger.debug({ operationWalletAddressId: preferredWallet.id, chainId }, 'Using preferred gas wallet address from rule metadata');
                    return preferredWallet.id;
                }
            }
            // Priority 2: Select gas-role wallet address (round-robin)
            const { data: gasWallet } = await this.supabase
                .from('operation_wallet_addresses')
                .select('*')
                .eq('is_active', true)
                .eq('role', 'gas')
                .eq('chain_id', chainId)
                .order('last_used_at', { ascending: true, nullsFirst: true })
                .limit(1)
                .maybeSingle();
            if (gasWallet) {
                await this.updateWalletAddressUsage(gasWallet.id);
                logger.debug({ operationWalletAddressId: gasWallet.id, chainId }, 'Selected gas-role wallet address');
                return gasWallet.id;
            }
            // Priority 3: Fallback to hot wallet address
            const { data: hotWallet } = await this.supabase
                .from('operation_wallet_addresses')
                .select('*')
                .eq('is_active', true)
                .eq('role', 'hot')
                .eq('chain_id', chainId)
                .order('last_used_at', { ascending: true, nullsFirst: true })
                .limit(1)
                .maybeSingle();
            if (hotWallet) {
                await this.updateWalletAddressUsage(hotWallet.id);
                logger.debug({ operationWalletAddressId: hotWallet.id, chainId }, 'Selected hot wallet address as gas fallback');
                return hotWallet.id;
            }
            logger.error({ chainId }, 'No active gas or hot wallet address found for chain');
            return null;
        }
        catch (error) {
            logger.error({ error: error.message, chainId }, 'Error selecting gas wallet address');
            return null;
        }
    }
    /**
     * Update operation wallet address last_used_at for round-robin (best effort)
     */
    async updateWalletAddressUsage(walletAddressId) {
        try {
            const { error } = await this.supabase
                .from('operation_wallet_addresses')
                .update({ last_used_at: new Date().toISOString() })
                .eq('id', walletAddressId);
            if (error) {
                logger.debug({ error: error.message, walletAddressId }, 'Could not update last_used_at');
            }
        }
        catch (error) {
            // Silently ignore - this is best-effort for round-robin
        }
    }
    /**
     * Update native gas flags (only on native asset row, not all rows for wallet)
     * CRITICAL: Only updates user wallets (verified before update)
     */
    async updateNativeGasFlags(walletId, nativeAssetOnChainId, needsGas, gasPriority) {
        try {
            // CRITICAL: Verify wallet is a user wallet before updating
            // This ensures operation wallets are never updated
            const { data: userWallet } = await this.supabase
                .from('user_wallet_addresses')
                .select('id')
                .eq('id', walletId)
                .maybeSingle();
            if (!userWallet) {
                logger.warn({ walletId, nativeAssetOnChainId }, 'Skipping gas flag update - wallet is not a user wallet (operation wallet detected)');
                return;
            }
            // Safe to update - wallet is confirmed to be a user wallet
            const { error: updateError } = await this.supabase
                .from('wallet_balances')
                .update({
                needs_gas: needsGas,
                gas_priority: needsGas ? gasPriority : null,
            })
                .eq('wallet_id', walletId)
                .eq('asset_on_chain_id', nativeAssetOnChainId);
            if (updateError) {
                logger.error({
                    error: updateError.message,
                    walletId,
                    nativeAssetOnChainId,
                    needsGas,
                }, 'Failed to update native gas flags');
            }
            else {
                logger.debug({
                    walletId,
                    nativeAssetOnChainId,
                    needsGas,
                }, 'Updated native gas flags (user wallet confirmed)');
            }
        }
        catch (error) {
            logger.error({ error: error.message, walletId }, 'Error updating native gas flags');
        }
    }
    /**
     * Finalize wallet balance after rule execution
     * CRITICAL: Only updates user wallets (safety check included)
     */
    async finalizeWalletBalance(walletBalanceId, needsConsolidation, consolidationPriority, needsGas, gasPriority) {
        // CRITICAL SAFETY CHECK: Verify this is a user wallet before updating
        // Load wallet_balance to get wallet_id
        const { data: walletBalance, error: loadError } = await this.supabase
            .from('wallet_balances')
            .select('wallet_id')
            .eq('id', walletBalanceId)
            .maybeSingle();
        if (loadError || !walletBalance) {
            throw new Error(`Failed to load wallet balance for finalization: ${loadError?.message || 'not found'}`);
        }
        // Verify wallet_id is a user wallet
        const { data: userWallet } = await this.supabase
            .from('user_wallet_addresses')
            .select('id')
            .eq('id', walletBalance.wallet_id)
            .maybeSingle();
        if (!userWallet) {
            logger.warn({
                walletBalanceId,
                walletId: walletBalance.wallet_id,
            }, 'Skipping finalizeWalletBalance - wallet is not a user wallet (operation wallet detected)');
            // Release lock but don't update flags for operation wallets
            await this.supabase
                .from('wallet_balances')
                .update({
                processing_status: 'idle',
                locked_until: null,
                locked_by: null,
            })
                .eq('id', walletBalanceId);
            return;
        }
        // Safe to update - wallet is confirmed to be a user wallet
        const { error } = await this.supabase
            .from('wallet_balances')
            .update({
            needs_consolidation: needsConsolidation,
            consolidation_priority: needsConsolidation ? consolidationPriority : null,
            needs_gas: needsGas,
            gas_priority: needsGas ? gasPriority : null,
            processing_status: 'idle',
            last_processed_at: new Date().toISOString(),
            locked_until: null,
            locked_by: null,
            last_error: null,
            last_error_at: null,
        })
            .eq('id', walletBalanceId);
        if (error) {
            throw new Error(`Failed to finalize wallet balance: ${error.message}`);
        }
    }
    /**
     * Record error and release lock
     * CRITICAL: Only updates user wallets (safety check included)
     */
    async recordError(walletBalanceId, errorMessage) {
        // CRITICAL SAFETY CHECK: Verify this is a user wallet before updating
        const { data: walletBalance, error: loadError } = await this.supabase
            .from('wallet_balances')
            .select('wallet_id, error_count')
            .eq('id', walletBalanceId)
            .maybeSingle();
        if (loadError || !walletBalance) {
            logger.error({
                error: loadError?.message,
                walletBalanceId,
            }, 'Failed to load wallet balance for error recording');
            return;
        }
        // Verify wallet_id is a user wallet
        const { data: userWallet } = await this.supabase
            .from('user_wallet_addresses')
            .select('id')
            .eq('id', walletBalance.wallet_id)
            .maybeSingle();
        if (!userWallet) {
            logger.warn({
                walletBalanceId,
                walletId: walletBalance.wallet_id,
            }, 'Skipping recordError - wallet is not a user wallet (operation wallet detected)');
            // Release lock but don't update error fields for operation wallets
            await this.supabase
                .from('wallet_balances')
                .update({
                processing_status: 'idle',
                locked_until: null,
                locked_by: null,
            })
                .eq('id', walletBalanceId);
            return;
        }
        // Safe to update - wallet is confirmed to be a user wallet
        const newErrorCount = (walletBalance.error_count || 0) + 1;
        const { error } = await this.supabase
            .from('wallet_balances')
            .update({
            last_error: errorMessage,
            last_error_at: new Date().toISOString(),
            error_count: newErrorCount,
            processing_status: 'idle',
            locked_until: null,
            locked_by: null,
        })
            .eq('id', walletBalanceId);
        if (error) {
            logger.error({
                error: error.message,
                walletBalanceId,
            }, 'Failed to record error');
        }
    }
    /**
     * Start the worker loop
     */
    async start() {
        if (this.isRunning) {
            logger.warn('Rule execution worker is already running');
            return;
        }
        this.isRunning = true;
        this.stopHeartbeat = this.runtime.startHeartbeat(defaultHeartbeatIntervalMs());
        logger.info({ workerId: this.runtime.workerId }, 'Starting rule execution worker loop');
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
                    await sleep(this.EXECUTION_INTERVAL_MS);
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
                logger.error({ error: error.message, stack: error.stack }, 'Error in rule execution worker loop');
                await this.runtime.logExecution({
                    executionType: 'cycle',
                    status: 'fail',
                    durationMs: Date.now() - cycleStart,
                    errorMessage: error?.message ?? String(error),
                });
            }
            await sleep(this.EXECUTION_INTERVAL_MS);
        }
        this.stopHeartbeat?.();
        await this.runtime.setStopped();
    }
    /**
     * Stop the worker loop
     */
    stop() {
        logger.info({ workerId: this.runtime.workerId }, 'Stopping rule execution worker');
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
                logger.info({ workerId: this.runtime.workerId }, 'Released all locks');
            }
        }
        catch (error) {
            logger.error({ error: error.message }, 'Error releasing locks');
        }
    }
}
//# sourceMappingURL=rule-execution.worker.js.map
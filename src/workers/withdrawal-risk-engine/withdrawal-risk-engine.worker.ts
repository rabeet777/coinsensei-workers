import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';
import { sleep, sleepWithBackoff } from '../../utils/sleep.js';
import {
  WorkerRuntime,
  workerIdentity,
  defaultHeartbeatIntervalMs,
} from '../../control-plane/worker-runtime.js';
import type {
  WithdrawalRequestRow,
  WithdrawalPolicyRow,
  RiskEvaluationResult,
  RiskDecision,
} from './types.js';

const BATCH_SIZE = Math.min(
  Math.max(parseInt(process.env.RISK_ENGINE_BATCH_SIZE || '50', 10), 1),
  200
);
const POLL_INTERVAL_MS = parseInt(
  process.env.RISK_ENGINE_INTERVAL_MS || process.env.SCAN_INTERVAL_MS || '10000',
  10
);
const JITTER_MS = 500;

function withJitter(ms: number): number {
  return ms + Math.floor(Math.random() * (JITTER_MS * 2 + 1)) - JITTER_MS;
}

export class WithdrawalRiskEngineWorker {
  private supabase: SupabaseClient;
  private runtime: WorkerRuntime;
  private isRunning = false;
  private stopHeartbeat: (() => void) | null = null;

  constructor() {
    this.supabase = getSupabaseClient();
    this.runtime = new WorkerRuntime(
      workerIdentity('withdrawal_risk_engine', null)
    );
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Withdrawal Risk Engine Worker...');
    await this.runtime.register();
    const { error } = await this.supabase.from('chains').select('id').limit(1);
    if (error) {
      throw new Error(`Failed to connect to database: ${error.message}`);
    }
    logger.info(
      {
        workerId: this.runtime.workerId,
        batchSize: BATCH_SIZE,
        pollIntervalMs: POLL_INTERVAL_MS,
      },
      'Withdrawal Risk Engine Worker initialized'
    );
  }

  /**
   * Claim pending rows atomically (risk_processing). Returns claimed rows.
   */
  private async claimPending(): Promise<WithdrawalRequestRow[]> {
    const { data, error } = await this.supabase.rpc(
      'claim_pending_withdrawal_requests_for_risk',
      { limit_count: BATCH_SIZE }
    );
    if (error) {
      logger.error(
        { error: error.message, operation: 'claim_pending' },
        'RPC claim failed'
      );
      throw error;
    }
    if (!Array.isArray(data)) return [];
    return data as WithdrawalRequestRow[];
  }

  private getAmountHuman(row: WithdrawalRequestRow): number | null {
    const v = row.amount_human ?? row.amount;
    if (v === undefined || v === null) return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
  }

  private async loadChainIsActive(chainId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('chains')
      .select('id, is_active')
      .eq('id', chainId)
      .maybeSingle();
    if (error || !data) return false;
    return data.is_active === true;
  }

  private async loadPolicy(
    assetOnChainId: string
  ): Promise<WithdrawalPolicyRow | null> {
    const { data, error } = await this.supabase
      .from('withdrawal_policies')
      .select('*')
      .eq('asset_on_chain_id', assetOnChainId)
      .maybeSingle();
    if (error || !data) return null;
    return data as WithdrawalPolicyRow;
  }

  /**
   * Evaluate a single request: chain active, policy present/enabled, amount vs limits.
   * Fail-safe: any uncertainty -> manual_review.
   */
  private evaluate(
    request: WithdrawalRequestRow,
    chainActive: boolean,
    policy: WithdrawalPolicyRow | null
  ): { decision: RiskDecision; requiresDualApproval: boolean; result: RiskEvaluationResult } {
    const amountHuman = this.getAmountHuman(request);
    const evaluatedAt = new Date().toISOString();
    const baseResult = {
      version: 1 as const,
      type: 'amount_only' as const,
      evaluated_at: evaluatedAt,
      policy: {
        auto_approve_limit: 0,
        dual_approval_limit: 0,
      },
      chain_active: chainActive,
      decision: 'manual_review' as RiskDecision,
      requires_dual_approval: false,
      reason: '',
    };

    if (!chainActive) {
      return {
        decision: 'manual_review',
        requiresDualApproval: false,
        result: { ...baseResult, reason: 'CHAIN_DISABLED' },
      };
    }

    if (!policy) {
      return {
        decision: 'manual_review',
        requiresDualApproval: false,
        result: { ...baseResult, reason: 'POLICY_MISSING' },
      };
    }

    if (!policy.is_enabled) {
      return {
        decision: 'manual_review',
        requiresDualApproval: false,
        result: {
          ...baseResult,
          policy: {
            auto_approve_limit: parseFloat(policy.auto_approve_limit),
            dual_approval_limit: parseFloat(policy.dual_approval_limit),
          },
          reason: 'POLICY_DISABLED',
        },
      };
    }

    const autoLimit = parseFloat(policy.auto_approve_limit);
    const dualLimit = parseFloat(policy.dual_approval_limit);
    baseResult.policy = { auto_approve_limit: autoLimit, dual_approval_limit: dualLimit };

    if (amountHuman === null || !Number.isFinite(amountHuman)) {
      return {
        decision: 'manual_review',
        requiresDualApproval: false,
        result: { ...baseResult, reason: 'INVALID_AMOUNT' },
      };
    }

    const overDualLimit = amountHuman > dualLimit;
    if (overDualLimit) {
      return {
        decision: 'manual_review',
        requiresDualApproval: true,
        result: {
          ...baseResult,
          requires_dual_approval: true,
          reason: 'OVER_DUAL_APPROVAL_LIMIT',
        },
      };
    }
    if (amountHuman <= autoLimit) {
      return {
        decision: 'approved',
        requiresDualApproval: false,
        result: {
          ...baseResult,
          decision: 'approved',
          requires_dual_approval: false,
          reason: 'WITHIN_AUTO_APPROVE',
        },
      };
    }
    return {
      decision: 'manual_review',
      requiresDualApproval: false,
      result: {
        ...baseResult,
        requires_dual_approval: false,
        reason: 'OVER_AUTO_APPROVE_LIMIT',
      },
    };
  }

  /**
   * Finalize one request: set status and metadata.risk (merge with existing metadata).
   */
  private async finalize(
    requestId: string,
    decision: RiskDecision,
    result: RiskEvaluationResult,
    requiresDualApproval: boolean
  ): Promise<void> {
    const existing = await this.supabase
      .from('withdrawal_requests')
      .select('metadata')
      .eq('id', requestId)
      .single();
    const currentMeta = (existing.data?.metadata as Record<string, unknown>) ?? {};
    const nextMeta = {
      ...currentMeta,
      risk: {
        ...result,
        requires_dual_approval: requiresDualApproval,
      },
    };

    const { error } = await this.supabase
      .from('withdrawal_requests')
      .update({
        status: decision,
        metadata: nextMeta,
        updated_at: new Date().toISOString(),
      })
      .eq('id', requestId)
      .eq('status', 'risk_processing');

    if (error) {
      logger.error(
        { withdrawal_request_id: requestId, error: error.message },
        'Failed to finalize withdrawal request'
      );
      throw error;
    }
  }

  async processBatch(): Promise<{
    processed: number;
    approved: number;
    manual_review: number;
    errors: number;
  }> {
    let claimed: WithdrawalRequestRow[] = [];
    let approved = 0;
    let manualReview = 0;
    let errors = 0;

    try {
      claimed = await this.claimPending();
    } catch (e) {
      logger.error(
        { error: (e as Error).message },
        'Claim pending failed'
      );
      throw e;
    }

    if (claimed.length === 0) {
      return { processed: 0, approved: 0, manual_review: 0, errors: 0 };
    }

    logger.info(
      { count: claimed.length, workerId: this.runtime.workerId },
      'Processing claimed withdrawal requests'
    );

    for (const row of claimed) {
      const correlationId = row.id;
      try {
        if (row.status !== 'risk_processing') {
          logger.debug(
            { withdrawal_request_id: correlationId, status: row.status },
            'Skipping non risk_processing row'
          );
          continue;
        }

        const chainId = row.chain_id;
        const assetOnChainId = row.asset_on_chain_id;
        if (!chainId) {
          logger.warn(
            { withdrawal_request_id: correlationId },
            'Missing chain_id, routing to manual_review'
          );
          const result: RiskEvaluationResult = {
            version: 1,
            type: 'amount_only',
            evaluated_at: new Date().toISOString(),
            policy: { auto_approve_limit: 0, dual_approval_limit: 0 },
            chain_active: false,
            decision: 'manual_review',
            requires_dual_approval: false,
            reason: 'MISSING_CHAIN_ID',
          };
          await this.finalize(row.id, 'manual_review', result, false);
          manualReview++;
          continue;
        }

        if (!assetOnChainId) {
          logger.warn(
            { withdrawal_request_id: correlationId },
            'Missing asset_on_chain_id, routing to manual_review'
          );
          const result: RiskEvaluationResult = {
            version: 1,
            type: 'amount_only',
            evaluated_at: new Date().toISOString(),
            policy: { auto_approve_limit: 0, dual_approval_limit: 0 },
            chain_active: true,
            decision: 'manual_review',
            requires_dual_approval: false,
            reason: 'POLICY_MISSING',
          };
          await this.finalize(row.id, 'manual_review', result, false);
          manualReview++;
          continue;
        }

        const [chainActive, policy] = await Promise.all([
          this.loadChainIsActive(chainId),
          this.loadPolicy(assetOnChainId),
        ]);

        const { decision, requiresDualApproval, result } = this.evaluate(
          row,
          chainActive,
          policy
        );

        logger.info(
          {
            withdrawal_request_id: correlationId,
            decision: result.decision,
            reason: result.reason,
            requires_dual_approval: result.requires_dual_approval,
          },
          'Risk evaluation'
        );

        await this.finalize(row.id, decision, result, requiresDualApproval);
        if (decision === 'approved') approved++;
        else manualReview++;
      } catch (err: unknown) {
        errors++;
        logger.error(
          {
            withdrawal_request_id: correlationId,
            error: err instanceof Error ? err.message : String(err),
          },
          'Error processing withdrawal request'
        );
        // Optionally revert to pending for retry, or leave in risk_processing for manual fix.
        // Spec: fail-safe -> manual_review. So on unexpected error we could set to manual_review with reason ERROR.
        try {
          const result: RiskEvaluationResult = {
            version: 1,
            type: 'amount_only',
            evaluated_at: new Date().toISOString(),
            policy: { auto_approve_limit: 0, dual_approval_limit: 0 },
            chain_active: false,
            decision: 'manual_review',
            requires_dual_approval: false,
            reason: 'EVALUATION_ERROR',
          };
          await this.finalize(row.id, 'manual_review', result, false);
          manualReview++;
        } catch (finalizeErr) {
          logger.error(
            {
              withdrawal_request_id: correlationId,
              error: (finalizeErr as Error).message,
            },
            'Failed to set manual_review after error'
          );
        }
      }
    }

    logger.info(
      {
        processed: claimed.length,
        approved,
        manual_review: manualReview,
        errors,
        workerId: this.runtime.workerId,
      },
      'Risk engine cycle metrics'
    );
    return {
      processed: claimed.length,
      approved,
      manual_review: manualReview,
      errors,
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.stopHeartbeat = this.runtime.startHeartbeat(
      defaultHeartbeatIntervalMs()
    );
    logger.info(
      { workerId: this.runtime.workerId },
      'Starting Withdrawal Risk Engine loop'
    );

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
          await sleep(withJitter(POLL_INTERVAL_MS));
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
          await sleep(withJitter(POLL_INTERVAL_MS));
          continue;
        }

        const metrics = await this.processBatch();
        await this.runtime.logExecution({
          executionType: 'cycle',
          status: 'success',
          durationMs: Date.now() - cycleStart,
          jobsClaimed: metrics.processed,
          jobsProcessed: metrics.processed,
          jobsSuccess: metrics.approved,
          jobsFailed: metrics.errors,
          metadata: {
            approved: metrics.approved,
            manual_review: metrics.manual_review,
            errors: metrics.errors,
          },
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ error: msg }, 'Error in Risk Engine loop');
        await this.runtime.logExecution({
          executionType: 'cycle',
          status: 'fail',
          durationMs: Date.now() - cycleStart,
          errorMessage: msg,
        });
        await sleepWithBackoff(1);
      }

      await sleep(withJitter(POLL_INTERVAL_MS));
    }

    this.stopHeartbeat?.();
    await this.runtime.setStopped();
  }

  stop(): void {
    logger.info(
      { workerId: this.runtime.workerId },
      'Stopping Withdrawal Risk Engine'
    );
    this.isRunning = false;
  }

  async shutdown(): Promise<void> {
    this.stop();
    await this.runtime.setStopped();
  }
}

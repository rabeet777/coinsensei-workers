import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

export type WorkerStatusStatus = 'starting' | 'running' | 'paused' | 'stopped';
export type WorkerHealthStatus = 'healthy' | 'degraded' | 'paused' | 'unknown';

/** Incident mode from worker_configs (global). */
export type IncidentMode = 'normal' | 'degraded' | 'emergency';

export interface IncidentConfig {
  mode: IncidentMode;
  degraded_gas_allowed?: boolean;
}

/** Domain for incident-mode permission matrix. */
export type WorkerDomain =
  | 'balances'
  | 'deposits_listen'
  | 'deposits_confirm'
  | 'gas'
  | 'consolidation'
  | 'withdrawals'
  | 'orchestration';

export interface WorkerIdentity {
  workerId: string;
  workerType: string;
  chainId: string | null;
}

/** Map worker_type to domain (STEP-3 incident mode). */
export const WORKER_TYPE_TO_DOMAIN: Record<string, WorkerDomain> = {
  balance_sync: 'balances',
  deposit_listener: 'deposits_listen',
  deposit_confirmation: 'deposits_confirm',
  gas_topup_execute: 'gas',
  gas_topup_confirmation: 'gas',
  consolidation_execute: 'consolidation',
  consolidation_confirmation: 'consolidation',
  withdrawal_enqueue: 'withdrawals',
  withdrawal_execute: 'withdrawals',
  withdrawal_confirmation: 'withdrawals',
  rule_execution: 'orchestration',
};

export interface ExecutionLogEntry {
  executionType: string;
  status: 'success' | 'fail' | 'skip';
  jobsClaimed?: number;
  jobsProcessed?: number;
  jobsSuccess?: number;
  jobsFailed?: number;
  durationMs?: number;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface HeartbeatMetrics {
  status?: WorkerStatusStatus;
  healthStatus?: WorkerHealthStatus;
  currentMetrics?: Record<string, unknown> | null;
}

/**
 * Worker Control Plane runtime: identity, heartbeat, maintenance, execution logging, health.
 * Every worker MUST use this for consistent governance and observability.
 */
export class WorkerRuntime {
  private supabase: SupabaseClient;
  private readonly identity: WorkerIdentity;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(identity: WorkerIdentity) {
    this.supabase = getSupabaseClient();
    this.identity = identity;
  }

  get workerId(): string {
    return this.identity.workerId;
  }

  get workerType(): string {
    return this.identity.workerType;
  }

  get chainId(): string | null {
    return this.identity.chainId;
  }

  /**
   * Register worker on startup: insert or update worker_status (status=starting, health_status=unknown).
   */
  async register(): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase.from('worker_status').upsert(
      {
        worker_id: this.identity.workerId,
        worker_type: this.identity.workerType,
        chain_id: this.identity.chainId,
        status: 'starting',
        health_status: 'unknown',
        started_at: now,
        updated_at: now,
        current_metrics: null,
        jobs_processed: 0,
        jobs_success: 0,
        jobs_failed: 0,
      },
      { onConflict: 'worker_id' }
    );

    if (error) {
      logger.warn(
        { workerId: this.identity.workerId, error: error.message },
        'WorkerRuntime: register failed'
      );
      return;
    }
    logger.info(
      { workerId: this.identity.workerId, workerType: this.identity.workerType },
      'WorkerRuntime: registered'
    );
  }

  /**
   * Heartbeat: update worker_status.updated_at, status, health_status, and optional current_metrics.
   * Call on a fixed interval; continues even when worker is paused.
   * When status is running and no explicit healthStatus, set health_status to 'healthy'.
   */
  async heartbeat(metrics?: HeartbeatMetrics): Promise<void> {
    const status = metrics?.status ?? 'running';
    const healthStatus =
      metrics?.healthStatus ??
      (status === 'paused' ? 'paused' : 'healthy');

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      status,
      health_status: healthStatus,
      current_metrics: metrics?.currentMetrics ?? undefined,
    };
    Object.keys(updates).forEach((k) => {
      if (updates[k] === undefined) delete updates[k];
    });

    const { error } = await this.supabase
      .from('worker_status')
      .update(updates)
      .eq('worker_id', this.identity.workerId);

    if (error) {
      logger.warn(
        { workerId: this.identity.workerId, error: error.message },
        'WorkerRuntime: heartbeat failed'
      );
    }
  }

  /**
   * Start a heartbeat loop. Call stopHeartbeat() on shutdown.
   */
  startHeartbeat(intervalMs: number, metrics?: HeartbeatMetrics): () => void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    const tick = () => {
      this.heartbeat(metrics).catch(() => {});
    };
    tick();
    this.heartbeatTimer = setInterval(tick, intervalMs);
    return () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    };
  }

  /**
   * Read current Incident Mode from worker_configs (authoritative source).
   * Key: "incident_mode" (or global.incident_mode). Value: { mode, degraded_gas_allowed? }.
   * Returns default "normal" if no row or parse error.
   */
  async getIncidentConfig(): Promise<IncidentConfig> {
    try {
      const { data, error } = await this.supabase
        .from('worker_configs')
        .select('value')
        .eq('key', 'incident_mode')
        .maybeSingle();

      if (error || !data?.value) {
        return { mode: 'normal' };
      }
      const v = data.value as Record<string, unknown>;
      const mode = (v?.mode as IncidentMode) ?? 'normal';
      const valid: IncidentMode[] = ['normal', 'degraded', 'emergency'];
      return {
        mode: valid.includes(mode) ? mode : 'normal',
        degraded_gas_allowed: v?.degraded_gas_allowed === true,
      };
    } catch {
      return { mode: 'normal' };
    }
  }

  /**
   * Whether this worker's domain is allowed to execute under current Incident Mode.
   * Check AFTER maintenance. If false: do not claim jobs, set paused, log skip, continue heartbeat.
   */
  async checkIncidentModeAllowed(): Promise<boolean> {
    const config = await this.getIncidentConfig();
    const domain = WORKER_TYPE_TO_DOMAIN[this.identity.workerType];
    if (!domain) {
      logger.warn(
        { workerId: this.identity.workerId, workerType: this.identity.workerType },
        'WorkerRuntime: unknown worker_type for incident mode, allowing'
      );
      return true;
    }
    return isDomainAllowedByIncidentMode(domain, config);
  }

  /**
   * Check if an active maintenance window applies to this worker.
   * Match: (worker_type = this.workerType OR worker_type IS NULL) AND
   *       (chain_id = this.chainId OR chain_id IS NULL) AND
   *       now() BETWEEN start_time AND end_time.
   * Returns true if worker MUST NOT claim jobs (paused).
   */
  async checkMaintenance(): Promise<boolean> {
    const now = new Date().toISOString();
    let query = this.supabase
      .from('worker_maintenance')
      .select('id')
      .lte('start_time', now)
      .gte('end_time', now)
      .or(
        `worker_type.eq.${this.identity.workerType},worker_type.is.null`
      );

    if (this.identity.chainId) {
      query = query.or(
        `chain_id.eq.${this.identity.chainId},chain_id.is.null`
      );
    } else {
      query = query.is('chain_id', null);
    }

    const { data, error } = await query.limit(1);

    if (error) {
      logger.warn(
        { workerId: this.identity.workerId, error: error.message },
        'WorkerRuntime: checkMaintenance query failed'
      );
      return false;
    }
    return (data?.length ?? 0) > 0;
  }

  /**
   * Log one execution cycle and optionally increment worker_status counters.
   */
  async logExecution(entry: ExecutionLogEntry): Promise<void> {
    const row = {
      worker_id: this.identity.workerId,
      worker_type: this.identity.workerType,
      chain_id: this.identity.chainId,
      execution_type: entry.executionType,
      status: entry.status,
      jobs_claimed: entry.jobsClaimed ?? 0,
      jobs_processed: entry.jobsProcessed ?? 0,
      jobs_success: entry.jobsSuccess ?? 0,
      jobs_failed: entry.jobsFailed ?? 0,
      duration_ms: entry.durationMs ?? null,
      error_message: entry.errorMessage ?? null,
      metadata: entry.metadata ?? null,
    };

    const { error: insertError } = await this.supabase
      .from('worker_execution_logs')
      .insert(row);

    if (insertError) {
      logger.warn(
        { workerId: this.identity.workerId, error: insertError.message },
        'WorkerRuntime: logExecution insert failed'
      );
    }

    const deltaProcessed = entry.jobsProcessed ?? 0;
    const deltaSuccess = entry.jobsSuccess ?? 0;
    const deltaFailed = entry.jobsFailed ?? 0;
    if (deltaProcessed > 0 || deltaSuccess > 0 || deltaFailed > 0) {
      const { data: current } = await this.supabase
        .from('worker_status')
        .select('jobs_processed, jobs_success, jobs_failed')
        .eq('worker_id', this.identity.workerId)
        .single();

      if (current) {
        await this.supabase
          .from('worker_status')
          .update({
            jobs_processed: (current.jobs_processed ?? 0) + deltaProcessed,
            jobs_success: (current.jobs_success ?? 0) + deltaSuccess,
            jobs_failed: (current.jobs_failed ?? 0) + deltaFailed,
            updated_at: new Date().toISOString(),
          })
          .eq('worker_id', this.identity.workerId);
      }
    }
  }

  /**
   * Set health_status for admin interpretation.
   */
  async updateHealth(healthStatus: WorkerHealthStatus): Promise<void> {
    const { error } = await this.supabase
      .from('worker_status')
      .update({
        health_status: healthStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('worker_id', this.identity.workerId);

    if (error) {
      logger.warn(
        { workerId: this.identity.workerId, error: error.message },
        'WorkerRuntime: updateHealth failed'
      );
    }
  }

  /**
   * Set status = paused (e.g. when maintenance is active).
   */
  async setPaused(): Promise<void> {
    await this.heartbeat({ status: 'paused', healthStatus: 'paused' });
  }

  /**
   * Set status = stopped on graceful shutdown. Call from signal handler before process.exit()
   * so the DB is updated even when the process exits immediately.
   */
  async setStopped(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const { error } = await this.supabase
      .from('worker_status')
      .update({
        status: 'stopped',
        health_status: 'unknown',
        updated_at: new Date().toISOString(),
      })
      .eq('worker_id', this.identity.workerId);

    if (error) {
      logger.warn(
        { workerId: this.identity.workerId, error: error.message },
        'WorkerRuntime: setStopped failed'
      );
    }
  }
}

const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * Incident mode permission matrix (STEP-3).
 * NORMAL: all allowed.
 * DEGRADED: balances, deposits allowed; gas blocked unless degraded_gas_allowed; consolidation, withdrawals, orchestration blocked.
 * EMERGENCY: balances, deposits_listen allowed; deposits_confirm (crediting) blocked; gas, consolidation, withdrawals, orchestration blocked.
 */
export function isDomainAllowedByIncidentMode(
  domain: WorkerDomain,
  config: IncidentConfig
): boolean {
  if (config.mode === 'normal') return true;
  if (config.mode === 'degraded') {
    if (domain === 'balances' || domain === 'deposits_listen' || domain === 'deposits_confirm')
      return true;
    if (domain === 'gas') return config.degraded_gas_allowed === true;
    return false; // consolidation, withdrawals, orchestration blocked
  }
  // emergency
  if (domain === 'balances' || domain === 'deposits_listen') return true;
  return false; // deposits_confirm, gas, consolidation, withdrawals, orchestration blocked
}

/**
 * Create identity for a worker: worker_id unique per process, worker_type canonical, chain_id optional.
 */
export function workerIdentity(
  workerType: string,
  chainId: string | null = null
): WorkerIdentity {
  return {
    workerId: `${workerType}_${process.pid}`,
    workerType,
    chainId,
  };
}

export function defaultHeartbeatIntervalMs(): number {
  return DEFAULT_HEARTBEAT_MS;
}

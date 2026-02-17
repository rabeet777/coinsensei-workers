import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
/**
 * Worker Control Plane runtime: identity, heartbeat, maintenance, execution logging, health.
 * Every worker MUST use this for consistent governance and observability.
 */
export class WorkerRuntime {
    supabase;
    identity;
    heartbeatTimer = null;
    constructor(identity) {
        this.supabase = getSupabaseClient();
        this.identity = identity;
    }
    get workerId() {
        return this.identity.workerId;
    }
    get workerType() {
        return this.identity.workerType;
    }
    get chainId() {
        return this.identity.chainId;
    }
    /**
     * Register worker on startup: insert or update worker_status (status=starting, health_status=unknown).
     */
    async register() {
        const now = new Date().toISOString();
        const { error } = await this.supabase.from('worker_status').upsert({
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
        }, { onConflict: 'worker_id' });
        if (error) {
            logger.warn({ workerId: this.identity.workerId, error: error.message }, 'WorkerRuntime: register failed');
            return;
        }
        logger.info({ workerId: this.identity.workerId, workerType: this.identity.workerType }, 'WorkerRuntime: registered');
    }
    /**
     * Heartbeat: update worker_status.updated_at, status, and optional current_metrics.
     * Call on a fixed interval; continues even when worker is paused.
     */
    async heartbeat(metrics) {
        const updates = {
            updated_at: new Date().toISOString(),
            status: metrics?.status ?? 'running',
            health_status: metrics?.healthStatus ?? undefined,
            current_metrics: metrics?.currentMetrics ?? undefined,
        };
        // Remove undefined so we don't overwrite with null
        Object.keys(updates).forEach((k) => {
            if (updates[k] === undefined)
                delete updates[k];
        });
        const { error } = await this.supabase
            .from('worker_status')
            .update(updates)
            .eq('worker_id', this.identity.workerId);
        if (error) {
            logger.warn({ workerId: this.identity.workerId, error: error.message }, 'WorkerRuntime: heartbeat failed');
        }
    }
    /**
     * Start a heartbeat loop. Call stopHeartbeat() on shutdown.
     */
    startHeartbeat(intervalMs, metrics) {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
        const tick = () => {
            this.heartbeat(metrics).catch(() => { });
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
     * Check if an active maintenance window applies to this worker.
     * Match: (worker_type = this.workerType OR worker_type IS NULL) AND
     *       (chain_id = this.chainId OR chain_id IS NULL) AND
     *       now() BETWEEN start_time AND end_time.
     * Returns true if worker MUST NOT claim jobs (paused).
     */
    async checkMaintenance() {
        const now = new Date().toISOString();
        let query = this.supabase
            .from('worker_maintenance')
            .select('id')
            .lte('start_time', now)
            .gte('end_time', now)
            .or(`worker_type.eq.${this.identity.workerType},worker_type.is.null`);
        if (this.identity.chainId) {
            query = query.or(`chain_id.eq.${this.identity.chainId},chain_id.is.null`);
        }
        else {
            query = query.is('chain_id', null);
        }
        const { data, error } = await query.limit(1);
        if (error) {
            logger.warn({ workerId: this.identity.workerId, error: error.message }, 'WorkerRuntime: checkMaintenance query failed');
            return false;
        }
        return (data?.length ?? 0) > 0;
    }
    /**
     * Log one execution cycle and optionally increment worker_status counters.
     */
    async logExecution(entry) {
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
            logger.warn({ workerId: this.identity.workerId, error: insertError.message }, 'WorkerRuntime: logExecution insert failed');
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
    async updateHealth(healthStatus) {
        const { error } = await this.supabase
            .from('worker_status')
            .update({
            health_status: healthStatus,
            updated_at: new Date().toISOString(),
        })
            .eq('worker_id', this.identity.workerId);
        if (error) {
            logger.warn({ workerId: this.identity.workerId, error: error.message }, 'WorkerRuntime: updateHealth failed');
        }
    }
    /**
     * Set status = paused (e.g. when maintenance is active).
     */
    async setPaused() {
        await this.heartbeat({ status: 'paused', healthStatus: 'paused' });
    }
    /**
     * Set status = stopped on graceful shutdown.
     */
    async setStopped() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        const { error } = await this.supabase
            .from('worker_status')
            .update({
            status: 'stopped',
            updated_at: new Date().toISOString(),
        })
            .eq('worker_id', this.identity.workerId);
        if (error) {
            logger.warn({ workerId: this.identity.workerId, error: error.message }, 'WorkerRuntime: setStopped failed');
        }
    }
}
const DEFAULT_HEARTBEAT_MS = 30_000;
/**
 * Create identity for a worker: worker_id unique per process, worker_type canonical, chain_id optional.
 */
export function workerIdentity(workerType, chainId = null) {
    return {
        workerId: `${workerType}_${process.pid}`,
        workerType,
        chainId,
    };
}
export function defaultHeartbeatIntervalMs() {
    return DEFAULT_HEARTBEAT_MS;
}
//# sourceMappingURL=worker-runtime.js.map
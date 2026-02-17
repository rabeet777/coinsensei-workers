export type WorkerStatusStatus = 'starting' | 'running' | 'paused' | 'stopped';
export type WorkerHealthStatus = 'healthy' | 'degraded' | 'paused' | 'unknown';
export interface WorkerIdentity {
    workerId: string;
    workerType: string;
    chainId: string | null;
}
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
export declare class WorkerRuntime {
    private supabase;
    private readonly identity;
    private heartbeatTimer;
    constructor(identity: WorkerIdentity);
    get workerId(): string;
    get workerType(): string;
    get chainId(): string | null;
    /**
     * Register worker on startup: insert or update worker_status (status=starting, health_status=unknown).
     */
    register(): Promise<void>;
    /**
     * Heartbeat: update worker_status.updated_at, status, and optional current_metrics.
     * Call on a fixed interval; continues even when worker is paused.
     */
    heartbeat(metrics?: HeartbeatMetrics): Promise<void>;
    /**
     * Start a heartbeat loop. Call stopHeartbeat() on shutdown.
     */
    startHeartbeat(intervalMs: number, metrics?: HeartbeatMetrics): () => void;
    /**
     * Check if an active maintenance window applies to this worker.
     * Match: (worker_type = this.workerType OR worker_type IS NULL) AND
     *       (chain_id = this.chainId OR chain_id IS NULL) AND
     *       now() BETWEEN start_time AND end_time.
     * Returns true if worker MUST NOT claim jobs (paused).
     */
    checkMaintenance(): Promise<boolean>;
    /**
     * Log one execution cycle and optionally increment worker_status counters.
     */
    logExecution(entry: ExecutionLogEntry): Promise<void>;
    /**
     * Set health_status for admin interpretation.
     */
    updateHealth(healthStatus: WorkerHealthStatus): Promise<void>;
    /**
     * Set status = paused (e.g. when maintenance is active).
     */
    setPaused(): Promise<void>;
    /**
     * Set status = stopped on graceful shutdown.
     */
    setStopped(): Promise<void>;
}
/**
 * Create identity for a worker: worker_id unique per process, worker_type canonical, chain_id optional.
 */
export declare function workerIdentity(workerType: string, chainId?: string | null): WorkerIdentity;
export declare function defaultHeartbeatIntervalMs(): number;
//# sourceMappingURL=worker-runtime.d.ts.map
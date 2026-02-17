-- Worker Control Plane: governance, observability, and maintenance
-- worker_status: liveness and health per worker instance
CREATE TABLE IF NOT EXISTS worker_status (
  worker_id TEXT PRIMARY KEY,
  worker_type TEXT NOT NULL,
  chain_id UUID REFERENCES chains(id),
  status TEXT NOT NULL DEFAULT 'starting',
  health_status TEXT NOT NULL DEFAULT 'unknown',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_metrics JSONB,
  jobs_processed BIGINT NOT NULL DEFAULT 0,
  jobs_success BIGINT NOT NULL DEFAULT 0,
  jobs_failed BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_worker_status_worker_type ON worker_status(worker_type);
CREATE INDEX IF NOT EXISTS idx_worker_status_updated_at ON worker_status(updated_at);

-- worker_execution_logs: append-only execution evidence per cycle
CREATE TABLE IF NOT EXISTS worker_execution_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id TEXT NOT NULL,
  worker_type TEXT NOT NULL,
  chain_id UUID REFERENCES chains(id),
  execution_type TEXT NOT NULL,
  status TEXT NOT NULL,
  jobs_claimed INT NOT NULL DEFAULT 0,
  jobs_processed INT NOT NULL DEFAULT 0,
  jobs_success INT NOT NULL DEFAULT 0,
  jobs_failed INT NOT NULL DEFAULT 0,
  duration_ms INT,
  error_message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worker_execution_logs_worker_id ON worker_execution_logs(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_execution_logs_created_at ON worker_execution_logs(created_at);

-- worker_configs: key-value config lookup (e.g. heartbeat_interval_ms)
CREATE TABLE IF NOT EXISTS worker_configs (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- worker_maintenance: maintenance windows (worker_type and/or chain_id nullable = match all)
CREATE TABLE IF NOT EXISTS worker_maintenance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_type TEXT,
  chain_id UUID REFERENCES chains(id),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worker_maintenance_window ON worker_maintenance(start_time, end_time);

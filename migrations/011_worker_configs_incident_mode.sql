-- Default incident_mode for STEP-3 (Incident Mode).
-- Workers read from worker_configs where key = 'incident_mode'.
-- value: { "mode": "normal" | "degraded" | "emergency", "degraded_gas_allowed": boolean (optional) }
INSERT INTO worker_configs (key, value)
VALUES ('incident_mode', '{"mode": "normal"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

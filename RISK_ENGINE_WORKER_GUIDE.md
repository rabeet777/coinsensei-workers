# Withdrawal Risk Engine Worker

## Overview

The **withdrawal-risk-engine** worker runs **before** the enqueue stage. It evaluates pending withdrawal requests and sets their status to either `approved` or `manual_review` based on configurable policies stored in the database. It does **not** enqueue jobs or touch `withdrawal_queue`.

**Flow:** `withdrawal_requests` (status `pending`) → **Risk Engine** → status becomes `approved` or `manual_review` → existing **Enqueue** worker picks up `approved` and creates jobs in `withdrawal_queue`.

## How It Works

1. **Claim:** The worker atomically claims up to N rows with status `pending` by setting them to `risk_processing` using a Postgres function with `FOR UPDATE SKIP LOCKED`, so multiple instances do not double-process.
2. **Evaluate:** For each claimed request:
   - Resolve chain from `withdrawal_requests.chain_id` and check **chain kill switch** (`chains.is_active`). If the chain is inactive → `manual_review` with reason `CHAIN_DISABLED`.
   - Load **policy** by `asset_on_chain_id` from `withdrawal_policies`. If missing or disabled → `manual_review` (`POLICY_MISSING` or `POLICY_DISABLED`).
   - Compare `amount_human` to policy limits:
     - If `amount_human > dual_approval_limit` → `manual_review` and set `metadata.risk.requires_dual_approval = true`.
     - Else if `amount_human <= auto_approve_limit` → `approved`.
     - Else → `manual_review` (over auto limit but not over dual).
3. **Finalize:** Update the row: set `status` to `approved` or `manual_review`, and write evaluation details under `metadata.risk` (version, type, evaluated_at, policy snapshot, chain_active, decision, requires_dual_approval, reason).
4. **Idempotency:** Only rows with status `pending` are claimed; already-processed rows are skipped.

## Configuration

### Environment variables

- **SUPABASE_URL**, **SUPABASE_SERVICE_ROLE_KEY** — Required (same as other workers).
- **RISK_ENGINE_BATCH_SIZE** — Max rows to claim per cycle (default: `50`, max: `200`).
- **RISK_ENGINE_INTERVAL_MS** — Delay between cycles in ms (default: `10000`, or falls back to `SCAN_INTERVAL_MS`).

### Database: `withdrawal_policies`

Policies are keyed by **asset_on_chain_id** (one row per asset-on-chain).

| Column                 | Type           | Description |
|------------------------|----------------|-------------|
| asset_on_chain_id      | UUID (PK, FK)  | References `asset_on_chain.id` |
| auto_approve_limit     | NUMERIC(28,18) | Amount (human): ≤ this → can be approved |
| dual_approval_limit    | NUMERIC(28,18) | Amount (human): > this → manual_review + requires_dual_approval |
| is_enabled             | BOOLEAN        | If false, all requests for this asset → manual_review |
| bulk_max_count        | INTEGER        | Reserved for future bulk rules |
| bulk_max_total_amount | NUMERIC(28,18) | Reserved for future bulk rules |
| created_at, updated_at | TIMESTAMPTZ    | Set automatically |

### Chain kill switch

- Use **chains.is_active**. If `chains.is_active = false` for the request’s chain, the risk engine always sets decision to `manual_review` with reason `CHAIN_DISABLED` and `metadata.risk.chain_active = false`.

## Running the worker

```bash
# Development
npm run dev:risk-engine

# Production
npm run start:risk-engine
```

With PM2 (using the provided ecosystem config):

```bash
pm2 start ecosystem.config.cjs
# or only the risk engine:
pm2 start ecosystem.config.cjs --only withdrawal-risk-engine
```

## Operational notes

- **Safety:** On any uncertainty (missing policy, disabled policy, inactive chain, invalid amount, or evaluation error), the worker routes to `manual_review` and never auto-approves.
- **Concurrency:** Safe to run multiple risk-engine instances; the claim function uses `FOR UPDATE SKIP LOCKED` so each row is processed by only one instance.
- **Dual approval:** The risk engine only sets `metadata.risk.requires_dual_approval = true` when amount > dual_approval_limit and status to `manual_review`. It does **not** set status to `awaiting_second_approval`; that is for the admin approval workflow.
- **Logs:** Structured logs include `withdrawal_request_id` (correlation id). Each cycle logs metrics: processed, approved, manual_review, errors.
- **Control plane:** The worker uses the same WorkerRuntime (heartbeat, maintenance, incident mode). Its type is `withdrawal_risk_engine` and domain is `withdrawals`.

## Sample policy seed

After running the migration, insert policies (replace UUIDs with your `asset_on_chain.id` values):

```sql
-- USDT TRC20 and USDT BEP20 (get asset_on_chain_id from asset_on_chain + chain)
INSERT INTO withdrawal_policies (asset_on_chain_id, auto_approve_limit, dual_approval_limit, is_enabled)
VALUES
  ('<USDT_TRC20_ASSET_ON_CHAIN_ID>', 1000, 10000, true),
  ('<USDT_BEP20_ASSET_ON_CHAIN_ID>', 1000, 10000, true)
ON CONFLICT (asset_on_chain_id) DO UPDATE SET
  auto_approve_limit = EXCLUDED.auto_approve_limit,
  dual_approval_limit = EXCLUDED.dual_approval_limit,
  is_enabled = EXCLUDED.is_enabled,
  updated_at = NOW();
```

## Metadata written on each request

After evaluation, the worker merges into `withdrawal_requests.metadata`:

```json
{
  "risk": {
    "version": 1,
    "type": "amount_only",
    "evaluated_at": "2026-01-27T12:00:00.000Z",
    "policy": { "auto_approve_limit": 1000, "dual_approval_limit": 10000 },
    "chain_active": true,
    "decision": "approved",
    "requires_dual_approval": false,
    "reason": "WITHIN_AUTO_APPROVE"
  }
}
```

Possible `reason` values: `CHAIN_DISABLED`, `POLICY_MISSING`, `POLICY_DISABLED`, `INVALID_AMOUNT`, `WITHIN_AUTO_APPROVE`, `OVER_AUTO_APPROVE_LIMIT`, `OVER_DUAL_APPROVAL_LIMIT`, `MISSING_CHAIN_ID`, `EVALUATION_ERROR`.

## Migrations

Apply the migration that creates `withdrawal_policies`, the claim function, and ensures `withdrawal_requests.metadata` exists:

```bash
# Run migration 012_withdrawal_policies.sql against your Postgres (e.g. via Supabase SQL or psql)
```

See `migrations/012_withdrawal_policies.sql` for the full DDL and the seed template in comments.

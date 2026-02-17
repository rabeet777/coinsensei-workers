# Consolidation Confirmation Worker

## Overview

The Consolidation Confirmation Worker is responsible for confirming consolidation transactions on-chain for both TRON and BSC. It operates as a pure confirmation service that:

1. ✅ Confirms already-broadcasted transactions
2. ✅ Validates confirmation depth based on chain config
3. ✅ Finalizes job status and releases wallet locks
4. ❌ Does NOT sign or broadcast transactions
5. ❌ Does NOT modify balances directly
6. ❌ Does NOT create new jobs

## Architecture

### Multi-Chain Support

The worker supports multiple chains dynamically:
- **TRON**: Uses TronWeb for transaction confirmation
- **BSC/EVM**: Uses ethers.js for transaction confirmation
- Chain-specific logic is determined by `chain_id` from database

### Data Flow

```
consolidation_queue (status='confirming', tx_hash IS NOT NULL)
  ↓
Load chain config (RPC, confirmation_threshold, block_time)
  ↓
Fetch transaction receipt from blockchain
  ↓
Validate confirmation depth
  ↓
Check transaction result (success/failure)
  ↓
Finalize job and release locks
```

## Job Selection

The worker picks jobs from `consolidation_queue` where:
- `status = 'confirming'`
- `tx_hash IS NOT NULL`
- Ordered by `processed_at ASC` (oldest first)
- Batch size: 10 jobs per cycle

## Chain Configuration

For each job, the worker loads:
- `rpc_url`: RPC endpoint for blockchain queries
- `confirmation_threshold`: Required confirmations (e.g., 1 for TRON, 3 for BSC)
- `block_time_seconds`: Average block time for sleep intervals
- `chain_type`: 'tron' or 'evm' (auto-detected from chain name)

## Confirmation Logic

### TRON Confirmation

1. Call `getTransactionInfo(tx_hash)`
2. Check if transaction is mined (`blockNumber` exists)
3. Check if receipt exists
4. Get current block number
5. Calculate confirmations: `currentBlock - txBlock + 1`
6. Validate confirmation depth
7. Check receipt result:
   - `undefined` or `'SUCCESS'` → Success
   - Any other value → Failure

### BSC/EVM Confirmation

1. Call `eth_getTransactionReceipt(tx_hash)`
2. Check if receipt exists (transaction is mined)
3. Get current block number
4. Calculate confirmations: `currentBlock - receiptBlock + 1`
5. Validate confirmation depth
6. Check receipt status:
   - `status = 1` → Success
   - `status = 0` → Failure

## Success Finalization

When a transaction is confirmed successfully:

### 1. Update consolidation_queue

```sql
UPDATE consolidation_queue SET
  status = 'confirmed',
  processed_at = NOW(),
  retry_count = 0,
  error_message = NULL,
  gas_used = <from receipt>,
  gas_price = <from receipt>
WHERE id = <job_id>;
```

### 2. Update wallet_balances

```sql
UPDATE wallet_balances SET
  needs_consolidation = false,
  processing_status = 'idle',
  consolidation_locked_until = NULL,
  consolidation_locked_by = NULL,
  last_consolidation_at = NOW(),
  last_processed_at = NOW()
WHERE id = <wallet_balance_id>;
```

## Failure Finalization

When a transaction fails on-chain:

### 1. Update consolidation_queue

```sql
UPDATE consolidation_queue SET
  status = 'failed',
  processed_at = NOW(),
  error_message = <failure reason>
WHERE id = <job_id>;
```

### 2. Update wallet_balances

```sql
UPDATE wallet_balances SET
  processing_status = 'idle',
  consolidation_locked_until = NULL,
  consolidation_locked_by = NULL,
  last_processed_at = NOW()
WHERE id = <wallet_balance_id>;
```

**Note:** `needs_consolidation` is NOT cleared on failure. The rule execution worker will decide whether to retry.

## Retry Policy

- This worker does NOT increment `retry_count`
- Retries are implicit by rechecking `confirming` jobs
- If a transaction is not yet confirmed, the job remains in `confirming` state
- The worker will recheck the job on the next cycle

## Safety Rules

### ✅ Safe Operations

- Read transaction receipts
- Update job status
- Release wallet locks
- Record gas usage

### ❌ Forbidden Operations

- Never modify `on_chain_balance_raw` or `on_chain_balance_human`
- Never create new consolidation jobs
- Never touch `needs_gas` flag
- Never sign or broadcast transactions
- Never release locks unless job is completed or failed

## Observability

### Structured Logging

Every confirmation attempt logs:
- Job ID
- Chain name
- Transaction hash
- Current confirmations vs required
- Block numbers (tx block, current block)
- Gas used and gas price (on success)
- Error messages (on failure)

### Log Levels

- **DEBUG**: Job picked, confirmation status
- **INFO**: Success finalization, failure finalization
- **WARN**: Chain not found, client not initialized
- **ERROR**: RPC errors, database errors

## Idle Behavior

When no jobs are found:
- Worker sleeps for `average_block_time_seconds` across all chains
- Example: If TRON=3s and BSC=3s, sleep for 3 seconds
- Random debug log (10% chance) to avoid spam

## Running the Worker

### Start

```bash
npm run start:consolidation-confirmation
```

### Development (with auto-reload)

```bash
npm run dev:consolidation-confirmation
```

### Stop

Press `Ctrl+C` or send `SIGTERM` signal

## Environment Variables

The worker uses existing environment variables:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NODE_ENV`
- `LOG_LEVEL`

No additional configuration required.

## Database Schema

### consolidation_queue Table

```sql
CREATE TABLE consolidation_queue (
  id UUID PRIMARY KEY,
  chain_id UUID NOT NULL,
  wallet_id UUID NOT NULL,
  wallet_balance_id UUID NOT NULL,
  operation_wallet_address_id UUID NOT NULL,
  amount_raw TEXT NOT NULL,
  amount_human TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  reason TEXT,
  rule_id UUID,
  tx_hash TEXT,
  retry_count INTEGER DEFAULT 0,
  error_message TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ,
  gas_used BIGINT,          -- Added by migration 007
  gas_price TEXT,           -- Added by migration 007
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
```

### wallet_balances Table

```sql
CREATE TABLE wallet_balances (
  id UUID PRIMARY KEY,
  needs_consolidation BOOLEAN NOT NULL,
  needs_gas BOOLEAN NOT NULL,
  processing_status VARCHAR(20) NOT NULL,
  consolidation_locked_until TIMESTAMPTZ,
  consolidation_locked_by VARCHAR(50),
  last_consolidation_at TIMESTAMPTZ,
  last_processed_at TIMESTAMPTZ,
  ...
);
```

## Integration with Other Workers

### Consolidation Workers (TRON/BSC)

1. Pick job from `consolidation_queue`
2. Validate wallet state
3. Acquire consolidation lock
4. Call signer service (build, sign, broadcast)
5. Store `tx_hash` in job
6. Set job status to `confirming`
7. **Consolidation Confirmation Worker takes over**

### Gas Workers

Consolidation workers may need gas to execute. Gas workers top up wallets before consolidation.

### Rule Execution Worker

Creates consolidation jobs based on business rules and wallet balances.

## Monitoring

### Key Metrics

- Jobs confirmed per minute
- Average confirmation time (by chain)
- Failed transactions count
- RPC errors count
- Lock release success rate

### Health Checks

- Worker running: Check process
- RPC connectivity: Monitor RPC errors in logs
- Database connectivity: Monitor Supabase errors in logs

## Troubleshooting

### Transaction not confirming

**Symptom:** Job stuck in `confirming` for a long time

**Possible causes:**
1. Transaction not yet mined (wait longer)
2. RPC node out of sync (check RPC health)
3. Transaction dropped (check blockchain explorer)

**Solution:**
- Check transaction on blockchain explorer (TronScan, BscScan)
- If dropped, manually mark job as `failed`
- If pending, wait for more blocks

### Lock not released

**Symptom:** Wallet stuck in `consolidating` state

**Possible causes:**
1. Worker crashed mid-confirmation
2. Database update failed

**Solution:**
```sql
-- Manually release lock
UPDATE wallet_balances
SET processing_status = 'idle',
    consolidation_locked_until = NULL,
    consolidation_locked_by = NULL
WHERE id = '<wallet_balance_id>';
```

### RPC errors

**Symptom:** "Error confirming transaction" in logs

**Possible causes:**
1. RPC node down
2. Rate limiting
3. Network issues

**Solution:**
- Check RPC endpoint health
- Increase sleep interval
- Switch to different RPC endpoint
- Check for rate limiting

## Testing

### Manual Testing

1. Create a consolidation job with `status='confirming'` and valid `tx_hash`
2. Start the worker
3. Watch logs for confirmation progress
4. Verify job status changes to `confirmed`
5. Verify wallet lock is released

### Test Queries

```sql
-- Check job status
SELECT id, status, tx_hash, retry_count, processed_at, gas_used, gas_price
FROM consolidation_queue
WHERE id = '<job_id>';

-- Check wallet lock status
SELECT id, processing_status, consolidation_locked_until, needs_consolidation
FROM wallet_balances
WHERE id = '<wallet_balance_id>';

-- List all confirming jobs
SELECT id, chain_id, tx_hash, processed_at
FROM consolidation_queue
WHERE status = 'confirming'
ORDER BY processed_at ASC;
```

## Production Deployment

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
CMD ["npm", "run", "start:consolidation-confirmation"]
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: consolidation-confirmation-worker
spec:
  replicas: 1  # Single instance (no concurrency needed)
  selector:
    matchLabels:
      app: consolidation-confirmation-worker
  template:
    metadata:
      labels:
        app: consolidation-confirmation-worker
    spec:
      containers:
      - name: worker
        image: coinsensei/workers:latest
        command: ["npm", "run", "start:consolidation-confirmation"]
        env:
        - name: SUPABASE_URL
          valueFrom:
            secretKeyRef:
              name: supabase
              key: url
        - name: SUPABASE_SERVICE_ROLE_KEY
          valueFrom:
            secretKeyRef:
              name: supabase
              key: service-role-key
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
```

## Migration Guide

### Step 1: Run Database Migration

```bash
psql -d <database> -f migrations/007_add_gas_tracking_to_consolidation_queue.sql
```

### Step 2: Deploy Worker

```bash
npm run start:consolidation-confirmation
```

### Step 3: Monitor Logs

```bash
tail -f logs/consolidation-confirmation-worker.log
```

### Step 4: Verify

```sql
-- Check for confirmed jobs
SELECT COUNT(*) FROM consolidation_queue WHERE status = 'confirmed';

-- Check for released locks
SELECT COUNT(*) FROM wallet_balances WHERE consolidation_locked_by IS NULL;
```

## Summary

The Consolidation Confirmation Worker is a critical component of the consolidation system that:

✅ **Confirms** transactions on-chain across multiple chains  
✅ **Releases** wallet locks after confirmation  
✅ **Tracks** gas usage for analytics  
✅ **Handles** both success and failure cases  
✅ **Scales** with multiple chains dynamically  

It operates independently from the consolidation workers, providing clean separation of concerns and robust error handling.


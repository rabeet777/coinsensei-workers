# Consolidation Workers - TRON & BSC

## Overview

The Consolidation Workers are pure execution workers responsible for processing consolidation jobs created by the Rule Execution Worker. They validate wallet state, acquire locks, call the signer service, and move jobs to confirmation.

## Architecture

### Separation of Concerns

```
┌──────────────────────────┐
│  Rule Execution Worker   │ ← Evaluates rules, selects hot wallet, creates jobs
└────────────┬─────────────┘
             │
             ▼
    ┌─────────────────┐
    │ consolidation   │
    │     _queue      │
    └────────┬────────┘
             │
             ▼
┌──────────────────────────┐
│  Consolidation Workers   │ ← Validates, locks, calls signer, broadcasts
│   (TRON / BSC)          │
└────────────┬─────────────┘
             │
             ▼
    ┌─────────────────┐
    │ Job Status:     │
    │  'confirming'   │
    └────────┬────────┘
             │
             ▼
┌──────────────────────────┐
│  Confirmation Worker     │ ← Confirms on-chain, updates balances, releases locks
└──────────────────────────┘
```

## Database Schema

### consolidation_queue

```sql
CREATE TABLE consolidation_queue (
  id UUID PRIMARY KEY,
  chain_id UUID NOT NULL,
  wallet_id UUID NOT NULL,  -- User wallet
  wallet_balance_id UUID NOT NULL,
  operation_wallet_address_id UUID NOT NULL,  -- Hot wallet destination
  amount_raw TEXT NOT NULL,
  amount_human TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'normal',
  reason TEXT,
  rule_id UUID,
  tx_hash TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Unique Constraint:** One pending/processing/confirming job per wallet_balance_id

## TRON Consolidation Worker

### Purpose

Consolidates native TRX from user wallets to hot wallets.

### Job Selection

- Filters: `chain_id = TRON`, `status = 'pending'`, `scheduled_at <= now()`
- Ordering: `priority DESC`, `scheduled_at ASC`
- Picks one job at a time

### Pre-Execution Validation

Validates wallet_balances:
- ✅ `needs_consolidation = true`
- ✅ `needs_gas = false`
- ✅ `processing_status = 'idle'`
- ✅ `consolidation_locked_until IS NULL` or expired

If validation fails → mark job as `failed` (non-retryable)

### Lock Acquisition

Atomically updates wallet_balances:
```sql
UPDATE wallet_balances
SET processing_status = 'consolidation_processing',
    consolidation_locked_until = now() + interval '10 minutes',
    consolidation_locked_by = :worker_id
WHERE id = :wallet_balance_id
  AND processing_status = 'idle'
```

### Transaction Execution

1. Load source wallet (user_wallet_addresses)
2. Load destination wallet (operation_wallet_addresses)
3. Build transaction intent:
   ```typescript
   {
     type: 'send_trx',
     from: sourceAddress,
     to: hotWalletAddress,
     amount_sun: job.amount_raw
   }
   ```
4. Call signer service:
   ```typescript
   signerService.signTransaction({
     chain: 'tron',
     wallet_group_id,
     derivation_index,
     tx_intent
   })
   ```
5. Receive `tx_hash` from signer
6. Update job:
   ```sql
   UPDATE consolidation_queue
   SET tx_hash = :tx_hash,
       status = 'confirming',
       processed_at = now()
   WHERE id = :job_id
   ```

### Error Handling

**Retryable Errors:**
- Signer service timeout
- Network errors
- RPC errors
- `retry_count < 8` → backoff and retry

**Non-Retryable Errors:**
- Invalid wallet state
- Validation failures
- `retry_count >= 8` → mark as `failed`

**Backoff Formula:**
```
min(2^retry_count × 30 seconds, 15 minutes)
```

### What It NEVER Does

❌ Update on_chain_balance_raw/human  
❌ Mark needs_consolidation = false  
❌ Release consolidation locks  
❌ Create new jobs  
❌ Select wallets  

## BSC Consolidation Worker

### Purpose

Consolidates native BNB and BEP20 tokens from user wallets to hot wallets.

### Asset Type Detection

Loads `asset_on_chain.is_native` to determine:
- **Native BNB** → `native_transfer` intent
- **BEP20 Token** → `erc20_transfer` intent

### Transaction Execution

**For Native BNB:**
```typescript
{
  type: 'native_transfer',
  from: sourceAddress,
  to: hotWalletAddress,
  amount_wei: job.amount_raw
}
```

**For BEP20 Tokens:**
```typescript
{
  type: 'erc20_transfer',
  from: sourceAddress,
  to: hotWalletAddress,
  amount: job.amount_raw,
  contract_address: assetInfo.contract_address
}
```

### Signer Service Call

```typescript
signerService.signTransaction({
  chain: 'bsc',
  wallet_group_id,
  derivation_index,
  tx_intent
})
```

### Everything Else

Same as TRON:
- Job selection
- Pre-execution validation
- Lock acquisition
- Error handling
- Retry logic
- Non-interference guarantees

## Configuration

### Environment Variables

```bash
SUPABASE_URL=<your-supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<your-key>
SIGNER_BASE_URL=http://coinsensei-signer:3000
SIGNER_API_KEY=<your-signer-key>
```

### Worker Settings

- `POLL_INTERVAL_MS`: 15000 (15 seconds)
- `MAX_RETRIES`: 8
- `LOCK_DURATION_MINUTES`: 10
- Backoff: Exponential (30s to 15min)

## Running the Workers

### Development

```bash
# TRON
npm run dev:tron-consolidation

# BSC
npm run dev:bsc-consolidation
```

### Production

```bash
# TRON
npm run start:tron-consolidation

# BSC
npm run start:bsc-consolidation
```

## Logging

### Structured Logs

**Job Picked:**
```json
{
  "jobId": "uuid",
  "walletBalanceId": "uuid",
  "amount": "100.50",
  "priority": "normal"
}
```

**Lock Acquired:**
```json
{
  "jobId": "uuid",
  "walletBalanceId": "uuid",
  "lockUntil": "2026-01-09T01:00:00Z"
}
```

**Transaction Broadcasted:**
```json
{
  "jobId": "uuid",
  "txHash": "0xabc...",
  "from": "T...",
  "to": "T...",
  "amount": "100.50"
}
```

**Error:**
```json
{
  "jobId": "uuid",
  "error": "message",
  "retryCount": 3,
  "maxRetries": 8,
  "isRetryable": true
}
```

## State Machine

```
pending → [picked] → processing → [tx broadcasted] → confirming
                                                          ↓
                                      [confirmation worker] → confirmed
                                                          ↓
                                                        failed
```

## Guarantees

✅ **Idempotency:** Safe to restart at any time  
✅ **Concurrency:** Multiple instances supported  
✅ **Lock Safety:** Only one worker processes a job  
✅ **No Duplicates:** Unique constraint on wallet_balance_id  
✅ **Separation:** Never interferes with other workers  
✅ **Read-Only State:** Never updates balances or flags  

## Monitoring

### Key Metrics

- Jobs processed per minute
- Average processing time
- Retry rate
- Error rate
- Lock acquisition success rate

### Health Checks

- Signer service availability
- Database connectivity
- Chain RPC connectivity

## Testing

### Prerequisites

1. Run migration:
   ```bash
   psql $DATABASE_URL -f migrations/006_create_consolidation_queue.sql
   ```

2. Ensure tables exist:
   - `consolidation_queue`
   - `wallet_balances`
   - `user_wallet_addresses`
   - `operation_wallet_addresses`
   - `asset_on_chain`

3. Configure hot wallets in `operation_wallet_addresses`

### Test Flow

1. Start rule execution worker (creates jobs)
2. Start consolidation worker (processes jobs)
3. Verify jobs move to `confirming` state
4. Check logs for tx_hash
5. Verify locks are acquired
6. Confirm no balance/flag updates by consolidation worker

## Troubleshooting

### Job Stuck in Pending

**Causes:**
- Validation failing (check wallet state)
- Lock acquisition failing (check other workers)
- Scheduled_at in future

**Solution:**
- Check wallet_balances.processing_status
- Check consolidation_locked_until
- Check needs_gas flag

### Job Failing Immediately

**Causes:**
- needs_consolidation = false
- needs_gas = true
- processing_status != 'idle'

**Solution:**
- Verify wallet_balances state
- Check rule execution worker logs

### Signer Service Errors

**Causes:**
- Signer service down
- Invalid wallet_group_id
- Invalid derivation_index

**Solution:**
- Check signer service health
- Verify wallet configuration
- Check signer service logs

## Future Enhancements

- [ ] Batch consolidations (multiple jobs per tx)
- [ ] Gas optimization (dynamic fee selection)
- [ ] Parallel processing (multiple jobs concurrently)
- [ ] Metrics export (Prometheus)
- [ ] Alerting (failed jobs threshold)
- [ ] Dashboard (job queue visualization)

## Architecture Compliance

✅ **Pure Executor:** Only processes existing jobs  
✅ **No Decision Making:** Rule execution worker decides  
✅ **Stateless:** All state in database  
✅ **Restart-Safe:** Idempotent operations  
✅ **Observable:** Comprehensive logging  
✅ **Scalable:** Multiple instances supported  


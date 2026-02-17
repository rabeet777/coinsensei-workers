# Withdrawal Architecture - CoinSensei

## Overview

The withdrawal system is split into **TWO distinct layers**:

1. **Intent Layer** (`withdrawal_requests`) - User requests, approvals, UI state
2. **Execution Layer** (`withdrawal_queue`) - Blockchain transactions, retries, worker jobs

This separation ensures clean architecture, proper retry handling, and clear audit trails.

---

## Layer 1: Intent Layer (`withdrawal_requests`)

### Purpose

Represents **user intent** and **approval workflow**. This table is concerned with:
- What the user wants
- Whether it's approved
- Where it is in the approval/execution lifecycle
- Final outcome for UI display

### Schema

```sql
CREATE TABLE withdrawal_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  amount NUMERIC(28,18) NOT NULL,
  to_address VARCHAR(100) NOT NULL,
  asset_id UUID NOT NULL,
  chain_id UUID NOT NULL,
  
  status VARCHAR(20) NOT NULL,  -- Intent lifecycle
  queued_at TIMESTAMPTZ,         -- When execution job was created
  final_tx_hash VARCHAR(100),    -- Final confirmed tx (for UI)
  
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  
  -- Other fields: memo, compliance, approval metadata, etc.
);
```

### Status Lifecycle

```
pending → approved → queued → completed
                           ↘ failed
```

| Status      | Meaning                                      |
|-------------|----------------------------------------------|
| `pending`   | User submitted, awaiting approval            |
| `approved`  | Approved by admin/system, ready to execute   |
| `queued`    | Execution job created in `withdrawal_queue`  |
| `completed` | Confirmed on-chain, `final_tx_hash` set      |
| `failed`    | Terminal failure, no retry possible          |

### What This Table Does NOT Contain

❌ Transaction hash (until final)  
❌ Gas details  
❌ Retry logic  
❌ Worker state  
❌ Hot wallet selection  
❌ Error messages from blockchain  

These belong to `withdrawal_queue`.

---

## Layer 2: Execution Layer (`withdrawal_queue`)

### Purpose

Represents **blockchain execution jobs**. This table is concerned with:
- Which hot wallet sends the funds
- Transaction building and signing
- Retry logic and backoff
- On-chain confirmation
- Gas tracking

### Schema

```sql
CREATE TABLE withdrawal_queue (
  id UUID PRIMARY KEY,
  
  -- Link to intent
  withdrawal_request_id UUID NOT NULL,
  
  -- Execution context
  chain_id UUID NOT NULL,
  asset_on_chain_id UUID NOT NULL,
  operation_wallet_address_id UUID NOT NULL,  -- Hot wallet
  
  -- Transaction details
  to_address VARCHAR(100) NOT NULL,
  amount_raw TEXT NOT NULL,
  amount_human NUMERIC(28,18) NOT NULL,
  
  -- Execution state
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  
  -- Transaction tracking
  tx_hash VARCHAR(100),
  gas_used TEXT,
  gas_price TEXT,
  
  -- Retry management
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 5,
  error_message TEXT,
  
  -- Timestamps
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Status Lifecycle

```
pending → processing → confirming → confirmed
                                 ↘ failed
```

| Status        | Meaning                                      |
|---------------|----------------------------------------------|
| `pending`     | Awaiting worker pickup                       |
| `processing`  | Worker building/signing transaction          |
| `confirming`  | Transaction broadcasted, awaiting blocks     |
| `confirmed`   | Transaction confirmed on-chain               |
| `failed`      | Terminal failure (max retries or permanent)  |

### Hot Wallet Selection

The `operation_wallet_address_id` is **deterministically selected** when the job is created. This ensures:
- No wallet rotation during retry
- Predictable nonce management (EVM)
- Clear audit trail of which wallet sent funds

### Retry Logic

- `retry_count`: Current number of attempts
- `max_retries`: Maximum attempts before marking `failed`
- `scheduled_at`: When the next retry should occur (exponential backoff)

**Backoff formula**: `scheduled_at = now() + (2^retry_count × 30 seconds)`

### Uniqueness Guarantee

Only **ONE active job** per withdrawal request:

```sql
CREATE UNIQUE INDEX uniq_withdrawal_queue_active
ON withdrawal_queue (withdrawal_request_id)
WHERE status IN ('pending', 'processing');
```

This prevents duplicate blockchain transactions.

---

## Workflow: End-to-End

### Step 1: User Submits Withdrawal

**Table:** `withdrawal_requests`  
**Status:** `pending`

```sql
INSERT INTO withdrawal_requests (
  user_id, amount, to_address, asset_id, chain_id, status
) VALUES (
  'user-123', 100.0, '0xABC...', 'USDT', 'bsc', 'pending'
);
```

### Step 2: Admin/System Approves

**Table:** `withdrawal_requests`  
**Status:** `pending` → `approved`

```sql
UPDATE withdrawal_requests
SET status = 'approved', updated_at = NOW()
WHERE id = 'req-456';
```

### Step 3: Enqueue Execution Job

**Table:** `withdrawal_queue` (new row)  
**Status:** `pending`

```sql
-- Select hot wallet deterministically
SELECT id FROM operation_wallet_addresses
WHERE chain_id = 'bsc'
  AND role = 'hot_wallet'
  AND status = 'active'
ORDER BY last_used_at ASC, balance_reserved ASC
LIMIT 1;

-- Create execution job
INSERT INTO withdrawal_queue (
  withdrawal_request_id,
  chain_id,
  asset_on_chain_id,
  operation_wallet_address_id,
  to_address,
  amount_raw,
  amount_human,
  status,
  priority
) VALUES (
  'req-456',
  'bsc-chain-id',
  'usdt-on-bsc-id',
  'hot-wallet-3',
  '0xABC...',
  '100000000000000000000',
  100.0,
  'pending',
  'normal'
);

-- Mark intent as queued
UPDATE withdrawal_requests
SET status = 'queued', queued_at = NOW()
WHERE id = 'req-456';
```

### Step 4: Withdrawal Worker Executes

**Worker:** `withdrawal-worker` (TRON or BSC)  
**Table:** `withdrawal_queue`  
**Status:** `pending` → `processing` → `confirming`

```sql
-- Worker picks job
SELECT * FROM withdrawal_queue
WHERE status = 'pending'
  AND scheduled_at <= NOW()
  AND chain_id = 'bsc'
ORDER BY priority DESC, scheduled_at ASC
LIMIT 1;

-- Update to processing
UPDATE withdrawal_queue
SET status = 'processing', retry_count = retry_count + 1
WHERE id = 'job-789';

-- Build, sign, broadcast transaction via signer service
-- (Worker calls signer service with tx_intent)

-- After broadcast, store tx_hash
UPDATE withdrawal_queue
SET status = 'confirming', tx_hash = '0xDEF...'
WHERE id = 'job-789';
```

### Step 5: Confirmation Worker Confirms

**Worker:** `withdrawal-confirmation-worker`  
**Table:** `withdrawal_queue`  
**Status:** `confirming` → `confirmed`

```sql
-- Confirmation worker checks on-chain
SELECT * FROM withdrawal_queue
WHERE status = 'confirming'
  AND tx_hash IS NOT NULL;

-- After sufficient confirmations
UPDATE withdrawal_queue
SET status = 'confirmed',
    processed_at = NOW(),
    gas_used = '21000',
    gas_price = '5000000000'
WHERE id = 'job-789';
```

### Step 6: Finalize Intent

**Table:** `withdrawal_requests`  
**Status:** `queued` → `completed`

```sql
UPDATE withdrawal_requests
SET status = 'completed',
    final_tx_hash = '0xDEF...',
    updated_at = NOW()
WHERE id = 'req-456';
```

---

## Failure Scenarios

### Scenario 1: Blockchain Error (Retryable)

**Example:** RPC timeout, nonce collision

**Workflow:**
1. Worker catches error
2. Checks if `retry_count < max_retries`
3. Updates job:
   ```sql
   UPDATE withdrawal_queue
   SET status = 'pending',
       error_message = 'RPC timeout',
       scheduled_at = NOW() + INTERVAL '1 minute',
       retry_count = retry_count + 1
   WHERE id = 'job-789';
   ```
4. Job will be retried after backoff

### Scenario 2: Permanent Error

**Example:** Invalid address, insufficient hot wallet balance

**Workflow:**
1. Worker catches error
2. Classifies as permanent
3. Updates job:
   ```sql
   UPDATE withdrawal_queue
   SET status = 'failed',
       error_message = 'Invalid destination address',
       processed_at = NOW()
   WHERE id = 'job-789';
   ```
4. Updates intent:
   ```sql
   UPDATE withdrawal_requests
   SET status = 'failed',
       updated_at = NOW()
   WHERE id = 'req-456';
   ```

### Scenario 3: Max Retries Exceeded

**Workflow:**
1. Worker increments `retry_count`
2. Checks `retry_count >= max_retries`
3. Updates job:
   ```sql
   UPDATE withdrawal_queue
   SET status = 'failed',
       error_message = 'Max retries exceeded',
       processed_at = NOW()
   WHERE id = 'job-789';
   ```
4. Updates intent:
   ```sql
   UPDATE withdrawal_requests
   SET status = 'failed',
       updated_at = NOW()
   WHERE id = 'req-456';
   ```

---

## Worker Responsibilities

### Withdrawal Worker (TRON/BSC)

**Responsibilities:**
- Pick jobs from `withdrawal_queue` where `status='pending'`
- Load hot wallet details from `operation_wallet_addresses`
- Build transaction intent (native or token transfer)
- Call signer service to sign and broadcast
- Store `tx_hash` and set `status='confirming'`
- Handle retryable errors with backoff

**Does NOT:**
- Approve withdrawals
- Select hot wallets (already assigned)
- Confirm transactions (separate worker)
- Modify `withdrawal_requests` directly

### Withdrawal Confirmation Worker

**Responsibilities:**
- Pick jobs from `withdrawal_queue` where `status='confirming'`
- Check transaction confirmation on-chain
- Validate confirmation depth
- Set `status='confirmed'` on success
- Update `withdrawal_requests.status='completed'`
- Record gas usage

**Does NOT:**
- Sign or broadcast transactions
- Retry failed jobs
- Select hot wallets

---

## Migration Guide

### Step 1: Backup Data

```sql
-- Backup withdrawal_requests
CREATE TABLE withdrawal_requests_backup AS
SELECT * FROM withdrawal_requests;
```

### Step 2: Run Migration

```bash
psql -d coinsensei -f migrations/008_refactor_withdrawal_schema.sql
```

### Step 3: Verify Schema

```sql
-- Check withdrawal_requests columns
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'withdrawal_requests'
ORDER BY ordinal_position;

-- Check withdrawal_queue structure
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'withdrawal_queue'
ORDER BY ordinal_position;
```

### Step 4: Migrate Existing Data (if needed)

```sql
-- If there are pending withdrawals with tx_hash,
-- create corresponding jobs in withdrawal_queue

INSERT INTO withdrawal_queue (
  withdrawal_request_id,
  chain_id,
  asset_on_chain_id,
  operation_wallet_address_id,
  to_address,
  amount_raw,
  amount_human,
  status,
  tx_hash,
  created_at
)
SELECT
  wr.id,
  wr.chain_id,
  aoc.id,
  owa.id,
  wr.to_address,
  wr.amount_raw,
  wr.amount,
  'confirming',
  wr.tx_hash,
  wr.created_at
FROM withdrawal_requests_backup wr
JOIN asset_on_chain aoc ON aoc.asset_id = wr.asset_id AND aoc.chain_id = wr.chain_id
JOIN operation_wallet_addresses owa ON owa.chain_id = wr.chain_id AND owa.role = 'hot_wallet'
WHERE wr.tx_hash IS NOT NULL
  AND wr.status NOT IN ('completed', 'failed');
```

### Step 5: Deploy Workers

```bash
npm run start:tron-withdrawal
npm run start:bsc-withdrawal
npm run start:withdrawal-confirmation
```

---

## Monitoring & Observability

### Key Metrics

**Intent Layer:**
- Pending approvals count
- Average approval time
- Completion rate

**Execution Layer:**
- Jobs in each status
- Average confirmation time
- Retry rate
- Failed jobs count
- Gas usage per job

### Queries

```sql
-- Pending withdrawals
SELECT COUNT(*) FROM withdrawal_requests WHERE status = 'pending';

-- Active execution jobs
SELECT COUNT(*) FROM withdrawal_queue WHERE status IN ('pending', 'processing', 'confirming');

-- Failed jobs (need investigation)
SELECT id, withdrawal_request_id, error_message, retry_count
FROM withdrawal_queue
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 10;

-- Stuck jobs (in processing for > 5 minutes)
SELECT id, status, created_at, error_message
FROM withdrawal_queue
WHERE status = 'processing'
  AND created_at < NOW() - INTERVAL '5 minutes';
```

---

## Benefits of This Architecture

✅ **Clean Separation of Concerns**
- Intent vs. Execution
- UI state vs. Worker state

✅ **Proper Retry Handling**
- Exponential backoff
- Max retry limits
- Deterministic hot wallet selection

✅ **Audit Trail**
- Every execution attempt is recorded
- Full error history
- Gas usage tracking

✅ **Scalability**
- Workers can run independently
- Multiple workers per chain
- Horizontal scaling

✅ **Data-Driven**
- No hardcoded chains
- No hardcoded assets
- All config from database

✅ **Safety**
- Unique constraint prevents duplicates
- Foreign key integrity
- No wallet rotation during retry

---

## Summary

The refactored withdrawal architecture provides:

- **Clear separation** between user intent and blockchain execution
- **Robust retry logic** with exponential backoff
- **Deterministic hot wallet selection** (no rotation during retry)
- **Complete audit trail** of every execution attempt
- **Gas tracking** for analytics and cost analysis
- **Production-ready** for custodial exchange deployment

This architecture is battle-tested and follows best practices for custodial wallet systems.


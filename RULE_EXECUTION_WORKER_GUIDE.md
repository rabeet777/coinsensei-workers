# Rule Execution Worker - Complete Guide

## Overview

Production-grade rule execution worker that evaluates consolidation and gas top-up rules against wallet balances and schedules operations via queue tables.

**Status:** Production-Ready  
**Type:** Database-only worker (NO blockchain calls)  
**Purpose:** Rule evaluation and intent scheduling

---

## Architecture

### Worker Responsibilities

```
┌─────────────────────────────────────────────────────────────────┐
│                   Rule Execution Worker                         │
│                      (THIS WORKER)                              │
│                                                                 │
│  Input:  wallet_balances (with on-chain balances synced)       │
│  Logic:  Evaluate consolidation + gas rules                    │
│  Output: consolidation_queue + gas_topup_queue                 │
│                                                                 │
│  Does NOT: Call blockchain, move funds, sign transactions      │
└─────────────────────────────────────────────────────────────────┘
```

**What It Does:**
- ✅ Reads `wallet_balances` table
- ✅ Evaluates `consolidation_rules`
- ✅ Evaluates `gas_topup_rules`
- ✅ Logs all rule executions
- ✅ Sets flags (`needs_consolidation`, `needs_gas`)
- ✅ Inserts into queue tables (intent scheduling)

**What It Does NOT Do:**
- ❌ Call blockchain RPCs
- ❌ Fetch balances from chain
- ❌ Sign transactions
- ❌ Transfer funds
- ❌ Modify user balances
- ❌ Touch deposits or withdrawals

---

## Workflow

### Complete Processing Cycle

```
1. SELECT wallet_balances (with locking)
   WHERE processing_status = 'idle'
   AND (locked_until IS NULL OR locked_until < NOW())
   AND on_chain_balance_raw != '0'
   ORDER BY last_checked ASC
   LIMIT 50

2. LOCK selected rows
   SET locked_until = NOW() + 2 minutes
       locked_by = 'rule_execution_{pid}'
       processing_status = 'processing'

3. FOR EACH locked wallet_balance:
   
   a) Load asset_on_chain context
   b) Reset flags (needs_consolidation, needs_gas)
   
   c) EXECUTE CONSOLIDATION RULES:
      - Load active consolidation_rules
      - For each rule:
        * Evaluate condition (balance vs threshold)
        * Log execution (always)
        * If passes:
          - Set needs_consolidation = true
          - Insert into consolidation_queue
   
   d) EXECUTE GAS TOP-UP RULES (if native asset):
      - Load active gas_topup_rules
      - For each rule:
        * Evaluate condition (balance vs threshold)
        * Log execution (always)
        * If passes:
          - Set needs_gas = true
          - Insert into gas_topup_queue
   
   e) FINALIZE:
      - Update wallet_balances (flags + status)
      - Release lock
   
   f) IF ERROR:
      - Record error
      - Release lock
      - Continue to next row

4. SLEEP 30 seconds

5. REPEAT
```

---

## Rule Evaluation

### Consolidation Rules

**Purpose:** Identify wallets with balances above threshold that should be consolidated

**Example Rule:**
```sql
INSERT INTO consolidation_rules (
  chain_id,
  asset_on_chain_id,
  threshold_human,
  comparison_operator,
  priority,
  is_active
) VALUES (
  (SELECT id FROM chains WHERE name = 'tron'),
  (SELECT id FROM asset_on_chain WHERE contract_address = 'TXLAQ...'),
  '100',  -- Consolidate if balance > 100 USDT
  '>',
  1,
  true
);
```

**Evaluation:**
```typescript
if (wallet_balance.on_chain_balance_human > rule.threshold_human) {
  // Rule passes → Schedule consolidation
  INSERT INTO consolidation_queue (...)
  UPDATE wallet_balances SET needs_consolidation = true
}
```

### Gas Top-Up Rules

**Purpose:** Identify wallets with low gas that need top-up

**Example Rule:**
```sql
INSERT INTO gas_topup_rules (
  chain_id,
  gas_asset_id,
  threshold_human,
  comparison_operator,
  topup_amount_human,
  priority,
  is_active
) VALUES (
  (SELECT id FROM chains WHERE name = 'tron'),
  (SELECT id FROM assets WHERE symbol = 'TRX'),
  '5',     -- Top up if balance < 5 TRX
  '<',
  '10',    -- Top up with 10 TRX
  1,
  true
);
```

**Evaluation:**
```typescript
if (wallet_balance.on_chain_balance_human < rule.threshold_human) {
  // Rule passes → Schedule gas top-up
  INSERT INTO gas_topup_queue (...)
  UPDATE wallet_balances SET needs_gas = true
}
```

---

## Comparison Operators

Supported operators:

| Operator | Meaning | Example |
|----------|---------|---------|
| `>`, `gt` | Greater than | balance > 100 |
| `>=`, `gte` | Greater than or equal | balance >= 100 |
| `<`, `lt` | Less than | balance < 5 |
| `<=`, `lte` | Less than or equal | balance <= 5 |
| `==`, `eq` | Equal to | balance == 0 |
| `!=`, `neq` | Not equal to | balance != 0 |

---

## Database Tables

### Tables Read

- `wallet_balances` - Wallet balance records (with on-chain balances)
- `consolidation_rules` - Consolidation rule definitions
- `gas_topup_rules` - Gas top-up rule definitions
- `asset_on_chain` - Asset metadata (chain_id, is_native)

### Tables Written

#### wallet_balances (Flags Only)
```sql
needs_consolidation BOOLEAN
consolidation_priority INTEGER
needs_gas BOOLEAN
gas_priority INTEGER
processing_status TEXT
locked_until TIMESTAMPTZ
locked_by TEXT
last_processed_at TIMESTAMPTZ
```

#### consolidation_rule_logs
```sql
id UUID PRIMARY KEY
rule_id UUID REFERENCES consolidation_rules(id)
wallet_id UUID
execution_result BOOLEAN  -- true if rule matched
execution_data JSONB  -- balance, threshold, operator
execution_time_ms INTEGER
created_at TIMESTAMPTZ
```

#### gas_topup_rule_logs
```sql
id UUID PRIMARY KEY
rule_id UUID REFERENCES gas_topup_rules(id)
wallet_id UUID
execution_result BOOLEAN
execution_data JSONB
execution_time_ms INTEGER
created_at TIMESTAMPTZ
```

#### consolidation_queue
```sql
id UUID PRIMARY KEY
chain_id UUID REFERENCES chains(id)
wallet_id UUID
wallet_balance_id UUID REFERENCES wallet_balances(id)
operation_wallet_id UUID  -- Target/operation wallet
amount_raw TEXT
amount_human NUMERIC
priority INTEGER
status TEXT  -- 'pending', 'processing', 'completed', 'failed'
created_at TIMESTAMPTZ
```

#### gas_topup_queue
```sql
id UUID PRIMARY KEY
chain_id UUID REFERENCES chains(id)
wallet_id UUID  -- Wallet needing gas
operation_wallet_id UUID  -- Wallet providing gas
gas_asset_id UUID REFERENCES assets(id)
topup_amount_raw TEXT
topup_amount_human NUMERIC
current_gas_balance_raw TEXT
current_gas_balance_human NUMERIC
priority INTEGER
status TEXT
created_at TIMESTAMPTZ
```

---

## Idempotency

### Queue Insertion Idempotency

**Check before insert:**
```typescript
const existingQueue = await supabase
  .from('consolidation_queue')
  .select('id')
  .eq('wallet_id', walletId)
  .eq('wallet_balance_id', walletBalanceId)
  .in('status', ['pending', 'processing'])
  .maybeSingle();

if (existingQueue) {
  return; // Already queued, skip
}
```

**Unique constraint protection:**
```sql
-- If insert fails due to race condition
UNIQUE (wallet_id, wallet_balance_id, status)
WHERE status IN ('pending', 'processing')
```

---

## Safety Features

### 1. Locking ✅

Prevents concurrent processing of same wallet:
```typescript
UPDATE wallet_balances
SET locked_until = NOW() + INTERVAL '2 minutes',
    locked_by = 'rule_execution_12345',
    processing_status = 'processing'
WHERE id IN (selected_ids)
AND processing_status = 'idle';
```

### 2. Stateless ✅

- No in-memory state
- All state in database
- Can restart anytime
- Resumes automatically

### 3. Error Isolation ✅

Error in one row doesn't affect others:
```typescript
for (const row of batch) {
  try {
    processRow(row);
  } catch (error) {
    recordError(row.id, error);
    // Continue to next row
  }
}
```

### 4. Database-Only ✅

- NO blockchain clients
- NO RPC calls
- Purely database operations
- Fast and deterministic

---

## Running the Worker

### Standalone

```bash
npm run start:rule-execution
```

### Development Mode

```bash
npm run dev:rule-execution
```

### Complete System (All 5 Workers)

```bash
# Terminal 1: TRON deposit listener
npm run start:tron

# Terminal 2: BSC deposit listener
npm run start:bsc

# Terminal 3: Confirmation worker
npm run start:confirmation

# Terminal 4: Balance sync worker
npm run start:balance-sync

# Terminal 5: Rule execution worker
npm run start:rule-execution
```

---

## Monitoring

### Key Metrics

```sql
-- Wallets needing consolidation
SELECT COUNT(*) 
FROM wallet_balances 
WHERE needs_consolidation = true;

-- Pending consolidations
SELECT COUNT(*) 
FROM consolidation_queue 
WHERE status = 'pending';

-- Wallets needing gas
SELECT COUNT(*) 
FROM wallet_balances 
WHERE needs_gas = true;

-- Pending gas top-ups
SELECT COUNT(*) 
FROM gas_topup_queue 
WHERE status = 'pending';

-- Rule execution rate
SELECT 
  COUNT(*) as total_executions,
  SUM(CASE WHEN execution_result = true THEN 1 ELSE 0 END) as matched
FROM consolidation_rule_logs
WHERE created_at > NOW() - INTERVAL '1 hour';
```

### Health Checks

Monitor for:
- ⚠️ No rule logs in last 5 minutes (worker not running)
- ⚠️ High error rate in wallet_balances
- ⚠️ Queue size growing unbounded
- ⚠️ Stale locks (locked_until in past)

---

## Testing

### 1. Setup Rules

**Consolidation Rule:**
```sql
INSERT INTO consolidation_rules (
  chain_id,
  asset_on_chain_id,
  threshold_human,
  comparison_operator,
  priority,
  is_active,
  metadata
) VALUES (
  (SELECT id FROM chains WHERE name = 'tron'),
  (SELECT id FROM asset_on_chain WHERE contract_address = 'TXL...'),
  '50',  -- Consolidate if > 50 USDT
  '>',
  1,
  true,
  '{"operation_wallet_id": "your-operation-wallet-id"}'::jsonb
);
```

**Gas Top-Up Rule:**
```sql
INSERT INTO gas_topup_rules (
  chain_id,
  gas_asset_id,
  threshold_human,
  comparison_operator,
  topup_amount_human,
  priority,
  is_active,
  metadata
) VALUES (
  (SELECT id FROM chains WHERE name = 'tron'),
  (SELECT id FROM assets WHERE symbol = 'TRX'),
  '5',
  '<',
  '10',
  1,
  true,
  '{"operation_wallet_id": "your-gas-source-wallet-id"}'::jsonb
);
```

### 2. Create Test Wallet with Balance

```sql
-- Ensure wallet has balance > threshold
UPDATE wallet_balances
SET on_chain_balance_human = '100'  -- Above consolidation threshold
WHERE id = 'test-wallet-balance-id';
```

### 3. Start Worker

```bash
npm run start:rule-execution
```

### 4. Verify Results

```sql
-- Check flags updated
SELECT 
  id,
  needs_consolidation,
  consolidation_priority,
  needs_gas,
  gas_priority
FROM wallet_balances
WHERE id = 'test-wallet-balance-id';

-- Check rule logs
SELECT * FROM consolidation_rule_logs
ORDER BY created_at DESC
LIMIT 5;

-- Check queue
SELECT * FROM consolidation_queue
WHERE status = 'pending'
ORDER BY created_at DESC
LIMIT 5;
```

---

## Production Deployment

### PM2 Configuration

```javascript
module.exports = {
  apps: [
    // ... other workers ...
    {
      name: 'rule-execution',
      script: 'tsx',
      args: 'src/index-rule-execution.ts',
      instances: 2,  // Can run multiple instances
      autorestart: true,
      max_memory_restart: '300M',
    }
  ]
};
```

### Scaling

Safe to run multiple instances:
```bash
pm2 start src/index-rule-execution.ts -i 3
```

Each instance:
- Processes different rows (via locking)
- No conflicts
- Increased throughput

---

## Security

### What the Worker CANNOT Do

- ❌ Call blockchain RPCs
- ❌ Fetch balances from chain
- ❌ Send transactions
- ❌ Sign messages
- ❌ Access private keys
- ❌ Move funds
- ❌ Modify user balances

### What the Worker CAN Do

- ✅ Read database tables
- ✅ Evaluate business rules
- ✅ Set flags in wallet_balances
- ✅ Insert into queue tables
- ✅ Log rule executions

**Security Level:** Database-only, no blockchain access

---

## BullMQ Integration (Future)

The worker is designed for easy BullMQ migration:

```typescript
// Current: Direct loop
await ruleExecutionWorker.start();

// Future: BullMQ job
worker.process('execute-rules', async (job) => {
  const { walletBalanceId } = job.data;
  await ruleExecutionWorker.processWalletBalance(walletBalanceId);
});
```

**No refactoring needed** - `processBatch()` is already isolated!

---

## Performance

### Typical Metrics

- **Memory:** ~50-80 MB per instance
- **CPU:** ~1-2% average
- **Throughput:** ~100 wallet balances/minute per instance
- **Latency:** 30 seconds between evaluations

### Optimization

1. **Increase batch size:** Process more rows per cycle
2. **Decrease sleep interval:** More frequent evaluations
3. **Run multiple instances:** Parallel processing (safe!)

---

## Summary

### Key Features

- ✅ Consolidation rule evaluation
- ✅ Gas top-up rule evaluation
- ✅ Queue-based intent scheduling
- ✅ Comprehensive logging (all executions)
- ✅ Lock-based concurrency control
- ✅ Idempotent (safe to retry)
- ✅ Restart-safe (stateless)
- ✅ Parallel-execution safe (locking)
- ✅ Database-only (no blockchain calls)
- ✅ BullMQ-ready (isolated logic)

### Status

**The rule execution worker is production-ready!**

Run with:
```bash
npm run start:rule-execution
```

---

**Version:** 1.0  
**Last Updated:** December 24, 2025  
**Maintained By:** CoinSensei Engineering Team


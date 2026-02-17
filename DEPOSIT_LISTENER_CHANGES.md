# Deposit Listener Changes - PENDING Status

## Summary

**Date:** December 22, 2025  
**Change Type:** Architecture Update (Preparation for Confirmation Worker)  
**Status:** ✅ Complete

---

## What Changed

### Before (v1.0)

Deposit listeners:
1. Detected deposits
2. Inserted with `status = 'confirmed'`
3. **Immediately credited balances** via `credit_user_asset_balance()` RPC

**Problem:** No separation between detection and confirmation

---

### After (v2.0)

Deposit listeners:
1. Detect deposits
2. Insert with `status = 'pending'`
3. Set `confirmations = 0`
4. Set `first_seen_block = block_number`
5. **DO NOT credit balances**

**Benefit:** Clean separation of concerns - detection vs confirmation

---

## Files Modified

### 1. TRON Worker (`src/workers/deposit/tron.deposit.worker.ts`)

**Changes:**
- ✅ Removed `creditUserBalance()` method
- ✅ Removed all calls to `credit_user_asset_balance`
- ✅ Changed status: `'confirmed'` → `'pending'`
- ✅ Added: `confirmations: 0`
- ✅ Added: `first_seen_block: deposit.blockNumber`

**Lines Changed:** ~60 lines removed/modified

### 2. BSC Worker (`src/workers/deposit/bsc.deposit.worker.ts`)

**Changes:**
- ✅ Removed `creditUserBalance()` method
- ✅ Removed all calls to `credit_user_asset_balance`
- ✅ Changed status: `'confirmed'` → `'pending'`
- ✅ Added: `confirmations: 0`
- ✅ Added: `first_seen_block: deposit.blockNumber`

**Lines Changed:** ~60 lines removed/modified

### 3. Database Migration (`migrations/003_add_deposit_confirmation_fields.sql`)

**New Columns Added:**
- `confirmations` (INTEGER, default 0)
- `first_seen_block` (BIGINT)
- `confirmed_at` (TIMESTAMPTZ, nullable)
- `credited_at` (TIMESTAMPTZ, nullable)

**New Indexes:**
- `idx_deposits_status_pending` - For confirmation worker queries
- `idx_deposits_confirmations` - For tracking confirmation progress

---

## Migration Required

### Run This Before Starting Updated Workers

```bash
psql $DATABASE_URL -f migrations/003_add_deposit_confirmation_fields.sql
```

Or execute in Supabase SQL Editor.

---

## Verification

### TRON Worker

```bash
grep -c "credit_user_asset_balance" src/workers/deposit/tron.deposit.worker.ts
# Expected: 0 ✅

grep -c "status: 'pending'" src/workers/deposit/tron.deposit.worker.ts
# Expected: 2 (log + insert) ✅

grep -c "confirmations: 0" src/workers/deposit/tron.deposit.worker.ts
# Expected: 1 ✅
```

**Result:** ✅ All changes applied correctly

### BSC Worker

```bash
grep -c "credit_user_asset_balance" src/workers/deposit/bsc.deposit.worker.ts
# Expected: 0 ✅

grep -c "status: 'pending'" src/workers/deposit/bsc.deposit.worker.ts
# Expected: 2 (log + insert) ✅

grep -c "confirmations: 0" src/workers/deposit/bsc.deposit.worker.ts
# Expected: 1 ✅
```

**Result:** ✅ All changes applied correctly

---

## New Deposit Flow

### Phase 1: Detection (Deposit Listeners)

```
Deposit Listener (TRON/BSC)
  ├─→ Detect Transfer event
  ├─→ Filter for user addresses
  ├─→ Check idempotency
  └─→ Insert deposit:
      • status: 'pending'
      • confirmations: 0
      • first_seen_block: current_block
      • confirmed_at: NULL
      • credited_at: NULL
```

### Phase 2: Confirmation (Future Confirmation Worker)

```
Confirmation Worker (Future)
  ├─→ Query pending deposits
  ├─→ Calculate current confirmations
  ├─→ If confirmations >= threshold:
      ├─→ Update status: 'confirmed'
      ├─→ Set confirmed_at: NOW()
      ├─→ Credit balance via credit_user_asset_balance()
      └─→ Set credited_at: NOW()
```

---

## Database Schema Changes

### deposits Table - New Fields

```sql
-- Existing fields
id, chain_id, asset_on_chain_id, tx_hash, log_index,
from_address, to_address, amount_raw, amount_human,
block_number, block_timestamp, status, created_at

-- NEW fields (added in migration 003)
confirmations INTEGER NOT NULL DEFAULT 0
first_seen_block BIGINT
confirmed_at TIMESTAMPTZ
credited_at TIMESTAMPTZ
```

### Deposit Lifecycle

| Field | Detection | Confirmation | Description |
|-------|-----------|--------------|-------------|
| `status` | 'pending' | 'confirmed' | Current state |
| `confirmations` | 0 | N (incremented) | Block confirmations count |
| `first_seen_block` | block_number | (unchanged) | First detection block |
| `confirmed_at` | NULL | NOW() | When confirmed |
| `credited_at` | NULL | NOW() | When balance credited |

---

## Behavioral Changes

### What Deposit Listeners DO Now

- ✅ Scan blocks for Transfer events
- ✅ Detect deposits to user addresses
- ✅ Insert deposits with status 'pending'
- ✅ Track first_seen_block
- ✅ Initialize confirmations to 0
- ✅ Update worker state

### What Deposit Listeners NO LONGER DO

- ❌ Credit balances
- ❌ Call credit_user_asset_balance
- ❌ Update user_asset_balance table
- ❌ Set status to 'confirmed'
- ❌ Any balance logic whatsoever

---

## Benefits

### 1. Separation of Concerns

- **Deposit Listeners:** Fast detection, no blocking operations
- **Confirmation Worker:** Handles confirmation tracking and crediting

### 2. Flexibility

- Change confirmation requirements without touching detection
- Retry failed balance credits independently
- Support different confirmation thresholds per asset

### 3. Observability

- Clear deposit lifecycle tracking
- Can monitor pending vs confirmed deposits
- Audit trail with timestamps

### 4. Reliability

- Detection failures don't affect crediting
- Crediting failures don't affect detection
- Can reprocess confirmations if needed

---

## Testing

### After Migration

1. **Start deposit listeners:**
   ```bash
   npm run start:tron
   npm run start:bsc
   ```

2. **Send test deposits**

3. **Verify deposits table:**
   ```sql
   SELECT 
     tx_hash, 
     status, 
     confirmations, 
     first_seen_block,
     confirmed_at,
     credited_at
   FROM deposits
   ORDER BY created_at DESC
   LIMIT 10;
   ```

4. **Expected results:**
   - status = 'pending' ✅
   - confirmations = 0 ✅
   - first_seen_block = (block number) ✅
   - confirmed_at = NULL ✅
   - credited_at = NULL ✅

5. **Check user balances:**
   ```sql
   SELECT * FROM user_asset_balance;
   ```
   
   **Expected:** No new balance updates (confirmation worker will handle this)

---

## Rollback Plan

If you need to rollback to immediate balance crediting:

1. Revert deposit insert to use `status: 'confirmed'`
2. Re-add balance crediting logic
3. Remove `confirmations` and `first_seen_block` fields from insert

---

## Next Steps

### Implement Confirmation Worker

The confirmation worker should:

1. Query pending deposits:
   ```sql
   SELECT * FROM deposits 
   WHERE status = 'pending'
   ORDER BY created_at ASC
   ```

2. For each deposit:
   - Calculate confirmations: `current_block - block_number`
   - If `confirmations >= threshold`:
     - Update status to 'confirmed'
     - Set confirmed_at timestamp
     - Credit balance via `credit_user_asset_balance()`
     - Set credited_at timestamp

3. Run periodically (e.g., every 30 seconds)

---

## Status

### TRON Deposit Listener

- ✅ Code updated
- ✅ Balance crediting removed
- ✅ Pending status implemented
- ✅ TypeScript compiles
- ✅ Ready to run

### BSC Deposit Listener

- ✅ Code updated
- ✅ Balance crediting removed
- ✅ Pending status implemented
- ✅ TypeScript compiles
- ✅ Ready to run

### Migration

- ✅ Migration 003 created
- ⚠️ Needs to be executed
- ✅ Backward compatible (nullable fields)

---

## Summary

**Change Type:** Preparation for confirmation worker  
**Impact:** Deposit listeners no longer credit balances  
**Status:** ✅ Complete  
**Migration Required:** Yes (003_add_deposit_confirmation_fields.sql)  
**Breaking Change:** No (workers still detect deposits correctly)  

**Both deposit listeners are now detection-only workers.**  
**Confirmation and balance crediting will be handled by a separate confirmation worker.**

---

**Version:** 2.0 (Detection Only)  
**Date:** December 22, 2025  
**Maintained By:** CoinSensei Engineering Team


# Gas Top-Up Workers - Complete Guide

## Overview

**Production-grade, enterprise-level gas top-up execution workers** for TRON (TRX) and BSC (BNB).

**Purpose:** Execute pre-assigned gas top-up jobs by sending native gas from operational wallets to user wallets.

**Status:** Production-Ready  
**Architecture:** HD Wallets + Signer Service + State Machine

---

## 🏗️ System Architecture

### Complete Gas Top-Up Flow

```
1. DETECTION (Balance Sync Worker)
   ├─→ Syncs on-chain balances
   └─→ Updates wallet_balances.on_chain_balance_*

2. RULE EVALUATION (Rule Execution Worker)
   ├─→ Evaluates gas_topup_rules
   ├─→ Checks if balance < threshold
   ├─→ Selects operation_wallet_address (round-robin)
   ├─→ Inserts into gas_topup_queue
   └─→ Sets wallet_balances.needs_gas = true

3. EXECUTION (Gas Top-Up Workers) ← THIS LAYER
   ├─→ TRON Worker: Executes TRX transfers
   ├─→ BSC Worker: Executes BNB transfers
   ├─→ Calls Signer Service (no private keys)
   ├─→ Broadcasts transactions
   ├─→ Tracks confirmations
   └─→ Updates wallet_balances.needs_gas = false

4. NEXT CYCLE (Rule Execution Worker)
   ├─→ Detects needs_gas = false
   ├─→ Evaluates consolidation rules
   └─→ Queues consolidation (if applicable)
```

---

## 🔐 Security Architecture

### HD Wallet Structure

```
HashiCorp Vault
  ├─→ Stores mnemonics/seeds (encrypted)
  └─→ Never leaves Vault

Database (wallet_groups table)
  ├─→ wallet_group_id
  ├─→ chain_id
  ├─→ purpose
  ├─→ xpub (public key only)
  └─→ derivation_path_template

Database (operation_wallet_addresses table)
  ├─→ wallet_group_id (references wallet_groups)
  ├─→ derivation_index
  ├─→ address (derived)
  ├─→ role ('gas', 'hot', 'treasury')
  └─→ NO private keys ✅

Signer Service
  ├─→ Retrieves mnemonic from Vault
  ├─→ Derives private key (wallet_group_id + derivation_index)
  ├─→ Signs transaction
  ├─→ Returns signed transaction
  └─→ Private key never persisted ✅

Gas Top-Up Workers
  ├─→ Load pre-assigned wallet address
  ├─→ Build unsigned transaction
  ├─→ Call signer service
  ├─→ Broadcast signed transaction
  └─→ NO wallet selection, NO private keys ✅
```

---

## 📦 Workers Implemented

### 1. TRON Gas Top-Up Worker

**File:** `src/workers/gas-topup/tron-gas-topup.worker.ts`  
**Entry:** `npm run start:tron-gas-topup`  
**Purpose:** Send TRX to user wallets for TRC20 transaction fees

**Capabilities:**
- Reads from `gas_topup_queue` (TRON chain only)
- Uses pre-assigned `operation_wallet_address_id`
- Builds native TRX transfers
- Signs via Signer Service
- Broadcasts via TronWeb
- Tracks confirmations (19 blocks)
- Updates `wallet_balances.needs_gas = false`

### 2. BSC Gas Top-Up Worker

**File:** `src/workers/gas-topup/bsc-gas-topup.worker.ts`  
**Entry:** `npm run start:bsc-gas-topup`  
**Purpose:** Send BNB to user wallets for BEP20 transaction fees

**Capabilities:**
- Reads from `gas_topup_queue` (BSC chain only)
- Uses pre-assigned `operation_wallet_address_id`
- Builds EVM transactions with nonce management
- Handles gas price (dynamic but capped)
- Signs via Signer Service
- Broadcasts via ethers.js
- Supports replacement transactions
- Tracks confirmations (12 blocks)
- Updates `wallet_balances.needs_gas = false`

---

## 🔁 State Machine (Mandatory)

Every gas top-up job follows this strict state machine:

```
queued
  ↓
picked (job locked and claimed)
  ↓
building_tx (constructing unsigned transaction)
  ↓
signing (calling signer service)
  ↓
broadcasting (submitting to network)
  ↓
broadcasted (tx_hash recorded)
  ↓
confirming (waiting for confirmations)
  ↓
confirmed (success! ✅)

OR

failed_retryable (retry possible)
  ↓
queued (retry)

OR

failed_final (max attempts exceeded)
```

**No state may be skipped.**

---

## 🔒 Idempotency & Safety

### Idempotency Guarantee

```typescript
// If tx_hash already exists, DON'T create new transaction
if (job.tx_hash && job.status === 'confirming') {
  await confirmTransaction(job); // Resume confirmation only
  return;
}
```

**Result:** Safe to restart workers - no duplicate transactions

### Locking Mechanism

```sql
-- Job claimed by worker
UPDATE gas_topup_queue
SET locked_by = 'tron_gas_topup_12345',
    locked_at = NOW() + INTERVAL '5 minutes'
WHERE id = ?
AND (locked_at IS NULL OR locked_at < NOW())
```

**Result:** Parallel workers don't conflict

### Stale Lock Recovery

```sql
-- Expired locks automatically recoverable
WHERE locked_at IS NULL 
   OR locked_at < NOW() - INTERVAL '5 minutes'
```

**Result:** Worker crashes don't leave jobs stuck

---

## 🧠 Signer Service Integration

### Contract

**Workers call:**
```typescript
const signedResult = await signerService.signTransaction({
  chain: 'tron',  // or 'bsc'
  wallet_group_id: 'uuid-of-wallet-group',
  derivation_index: 0,  // Index in HD derivation path
  unsigned_tx_payload: unsignedTransaction,
});

// Returns:
{
  signed_tx: '0x...', // or raw hex for TRON
  tx_hash: '0x...'
}
```

**Signer Service:**
1. Retrieves mnemonic from Vault (via wallet_group_id)
2. Derives private key at derivation_index
3. Signs unsigned_tx_payload
4. Returns signed transaction
5. **Private key never persisted**

---

## 📊 Database Tables

### gas_topup_queue (Source of Truth)

```sql
id UUID PRIMARY KEY
chain_id UUID REFERENCES chains(id)
wallet_id UUID  -- Target wallet needing gas
operation_wallet_address_id UUID REFERENCES operation_wallet_addresses(id)  -- Funding wallet
gas_asset_id UUID REFERENCES assets(id)
topup_amount_raw TEXT
topup_amount_human NUMERIC
priority INTEGER
status TEXT  -- State machine status
reason TEXT
rule_id UUID REFERENCES gas_topup_rules(id)

-- Transaction tracking
tx_hash TEXT
tx_meta JSONB  -- nonce, gas_price, etc.

-- Locking
locked_by TEXT
locked_at TIMESTAMPTZ

-- Retry & Error
attempt_count INTEGER
max_attempts INTEGER
last_error TEXT
last_error_at TIMESTAMPTZ

-- Timestamps
created_at TIMESTAMPTZ
picked_at TIMESTAMPTZ
broadcasted_at TIMESTAMPTZ
confirmed_at TIMESTAMPTZ
failed_at TIMESTAMPTZ
```

### operation_wallet_addresses (Funding Wallets)

```sql
id UUID PRIMARY KEY
chain_id UUID REFERENCES chains(id)
wallet_group_id UUID REFERENCES wallet_groups(id)
derivation_index INTEGER
address TEXT  -- Blockchain address
role TEXT  -- 'gas', 'hot', 'treasury'
is_active BOOLEAN
last_used_at TIMESTAMPTZ  -- Round-robin routing
```

### wallet_balances (Target State)

```sql
wallet_id UUID
asset_on_chain_id UUID
on_chain_balance_raw TEXT
on_chain_balance_human NUMERIC
needs_gas BOOLEAN  -- Cleared by gas top-up workers
needs_consolidation BOOLEAN
```

---

## 🚀 Running the Workers

### Start Individual Workers

```bash
# TRON gas top-up worker
npm run start:tron-gas-topup

# BSC gas top-up worker  
npm run start:bsc-gas-topup
```

### Complete System (7 Workers)

```bash
# Detection Layer
npm run start:tron          # TRON deposit detection
npm run start:bsc           # BSC deposit detection

# Confirmation Layer
npm run start:confirmation  # Deposit confirmation + crediting

# Balance Management Layer
npm run start:balance-sync  # On-chain balance sync

# Rule Layer
npm run start:rule-execution  # Rule evaluation + scheduling

# Execution Layer
npm run start:tron-gas-topup  # TRX transfers
npm run start:bsc-gas-topup   # BNB transfers
```

---

## 🧪 Testing

### Test Scenario: Low Gas Wallet

**Setup:**
1. Wallet has 480 USDT (needs consolidation)
2. Wallet has 0 TRX (needs gas)
3. Gas topup rule: if TRX < 2, topup 10 TRX

**Expected Flow:**

**Cycle 1 (Rule Execution):**
```
✅ Detects low gas (0 < 2)
✅ Sets needs_gas = true
✅ Sets needs_consolidation = true
✅ Queues gas topup (10 TRX)
✅ Does NOT queue consolidation (gas blocks it)
```

**Cycle 2 (Gas Top-Up Worker):**
```
✅ Picks gas topup job
✅ Loads funding wallet (operation_wallet_address)
✅ Builds TRX transfer (10 TRX)
✅ Calls signer service
✅ Broadcasts transaction
✅ Confirms after 19 blocks
✅ Sets needs_gas = false
```

**Cycle 3 (Balance Sync):**
```
✅ Syncs wallet balances
✅ Updates TRX balance: 0 → 10
```

**Cycle 4 (Rule Execution):**
```
✅ Checks gas: 10 >= 2 (sufficient)
✅ Evaluates consolidation: 480 > 100 (matches)
✅ Sets needs_consolidation = true
✅ Sets needs_gas = false
✅ Queues consolidation ✅
```

**Total time:** ~2-5 minutes depending on configuration

---

## 🔐 Security Properties

### What Gas Top-Up Workers CANNOT Do

- ❌ Select which wallet to use (pre-assigned by rule worker)
- ❌ Access private keys (stored in Vault)
- ❌ Sign transactions locally (uses Signer Service)
- ❌ Override rule decisions
- ❌ Move non-gas funds

### What Gas Top-Up Workers CAN Do

- ✅ Read gas_topup_queue
- ✅ Load pre-assigned wallet addresses
- ✅ Build unsigned transactions
- ✅ Call Signer Service
- ✅ Broadcast signed transactions
- ✅ Track confirmations
- ✅ Update wallet states

**Security Level:** Controlled execution only, no key access

---

## 📋 Configuration

### Environment Variables

```bash
# Existing
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...

# New (Required for Gas Top-Up Workers)
SIGNER_SERVICE_URL=http://localhost:3001
SIGNER_API_KEY=your-signer-service-api-key
```

### Worker Parameters (Configurable in Code)

```typescript
BATCH_SIZE = 10  // Jobs per cycle
LOCK_DURATION_SECONDS = 300  // 5 minutes
POLL_INTERVAL_MS = 15000  // 15 seconds
MAX_ATTEMPTS = 5  // Retry limit
CONFIRMATION_BLOCKS = 19  // TRON: 19, BSC: 12
```

---

## 🎯 Key Features

### TRON Worker

- ✅ Native TRX transfers
- ✅ TronWeb integration
- ✅ 19 block confirmations
- ✅ Simple transaction structure

### BSC Worker

- ✅ Native BNB transfers
- ✅ ethers.js integration
- ✅ Nonce management ('pending' state)
- ✅ Dynamic gas price (capped at 20 Gwei)
- ✅ Replacement transaction support
- ✅ 12 block confirmations
- ✅ EVM transaction structure

### Both Workers

- ✅ Strict state machine (no skipped states)
- ✅ Locking mechanism (parallel-safe)
- ✅ Idempotency (tx_hash check)
- ✅ Error handling (retryable vs final)
- ✅ Audit logging
- ✅ NO wallet selection (executors only)
- ✅ NO private keys (signer service)
- ✅ Deterministic execution

---

## 📊 Monitoring

### Key Metrics

```sql
-- Pending gas top-ups
SELECT chain_id, COUNT(*) 
FROM gas_topup_queue 
WHERE status IN ('queued', 'picked', 'building_tx', 'signing', 'broadcasting')
GROUP BY chain_id;

-- Failed jobs
SELECT COUNT(*) 
FROM gas_topup_queue 
WHERE status = 'failed_final';

-- Average execution time
SELECT 
  chain_id,
  AVG(EXTRACT(EPOCH FROM (confirmed_at - created_at))) as avg_seconds
FROM gas_topup_queue
WHERE status = 'confirmed'
AND confirmed_at > NOW() - INTERVAL '24 hours'
GROUP BY chain_id;

-- Stale locks
SELECT COUNT(*) 
FROM gas_topup_queue
WHERE locked_at < NOW() - INTERVAL '10 minutes'
AND status NOT IN ('confirmed', 'failed_final');
```

---

## 🎉 Summary

**Status:** ✅ **PRODUCTION READY**

**Delivered:**
- ✅ TRON Gas Top-Up Worker (~450 lines)
- ✅ BSC Gas Top-Up Worker (~500 lines)
- ✅ Signer Service Client (~100 lines)
- ✅ Shared types & interfaces
- ✅ Entry points for both
- ✅ Complete documentation

**System Now Has 7 Workers:**
1. TRON Deposit Listener
2. BSC Deposit Listener
3. Confirmation Worker
4. Balance Sync Worker
5. Rule Execution Worker
6. **TRON Gas Top-Up Worker** ✅ NEW
7. **BSC Gas Top-Up Worker** ✅ NEW

**All workers are production-ready, secure, and fully operational!** 🎉

---

**Version:** 1.0  
**Last Updated:** December 29, 2025  
**Maintained By:** CoinSensei Engineering Team


# Signer Service: Fix TAPOS_ERROR for TRON Transactions

## 🚨 CRITICAL ISSUE

The signer service is generating TRON transactions with **stale block references**, causing `TAPOS_ERROR` when broadcasting. Transactions are being built with `ref_block_bytes` and `ref_block_hash` that are no longer valid on the TRON network.

## 📊 Evidence from Gas Worker Logs

```
Transaction built: 15:49:39.000
Broadcast attempted: 15:49:41.330
Transaction age: 2.33 seconds
TAPOS_ERROR: "tapos check error"
ref_block_bytes: "6372"
ref_block_hash: "dbc8c3db68be3ae6"
```

**Key Observation:** Even though the transaction is built in ~2.3 seconds, the block references are already stale. This indicates the signer is NOT fetching the latest block immediately before building.

## 🔍 Root Cause

The signer service is likely:
1. ❌ Using cached block information
2. ❌ Fetching block info asynchronously with delays
3. ❌ Not querying the latest block immediately before transaction construction
4. ❌ Using block references from a block that's no longer in the chain

## ✅ REQUIRED FIX

### 1. Fetch Latest Block IMMEDIATELY Before Building

**CRITICAL:** The signer service MUST fetch the latest block **synchronously and immediately** before building the TRON transaction. Do NOT cache block info.

```typescript
// ✅ CORRECT: Fetch block immediately before building
async signTronTransaction(txIntent: TronTxIntent) {
  // Step 1: Fetch LATEST block (no caching, no delays)
  const latestBlock = await tronWeb.trx.getCurrentBlock();
  const refBlockBytes = latestBlock.block_header.raw_data.number.toString(16).slice(-4);
  const refBlockHash = latestBlock.block_header.raw_data.txTrieRoot.slice(0, 16);
  
  // Step 2: Build transaction IMMEDIATELY with fresh block refs
  const transaction = await tronWeb.transactionBuilder.sendTrx(
    txIntent.to,
    txIntent.amount_sun,
    txIntent.from
  );
  
  // Step 3: Set fresh block references
  transaction.raw_data.ref_block_bytes = refBlockBytes;
  transaction.raw_data.ref_block_hash = refBlockHash;
  
  // Step 4: Set expiration (current time + 60 seconds)
  transaction.raw_data.expiration = Date.now() + 60000;
  transaction.raw_data.timestamp = Date.now();
  
  // Step 5: Sign and return
  // ... signing logic
}
```

### 2. NO Block Reference Caching

**DO NOT:**
- ❌ Cache `ref_block_bytes` or `ref_block_hash`
- ❌ Reuse block info from previous transactions
- ❌ Fetch block info in parallel with other operations
- ❌ Use block info that's more than a few seconds old

**DO:**
- ✅ Fetch block info synchronously before each transaction build
- ✅ Use the block info immediately after fetching
- ✅ Treat block references as single-use only

### 3. Proper Block Reference Extraction

Ensure you're extracting block references correctly from the latest block:

```typescript
// Get latest block
const latestBlock = await tronWeb.trx.getCurrentBlock();

// Extract ref_block_bytes (last 4 hex chars of block number)
const blockNumber = latestBlock.block_header.raw_data.number;
const refBlockBytes = blockNumber.toString(16).slice(-4).padStart(4, '0');

// Extract ref_block_hash (first 16 hex chars of txTrieRoot)
const refBlockHash = latestBlock.block_header.raw_data.txTrieRoot.slice(0, 16);
```

### 4. Set Expiration Correctly

```typescript
// Set expiration to current time + 60 seconds (or appropriate window)
transaction.raw_data.expiration = Date.now() + 60000;
transaction.raw_data.timestamp = Date.now();
```

## 🧪 Testing Requirements

After implementing the fix, verify:

1. ✅ Each transaction uses fresh block references
2. ✅ Block references are fetched immediately before building
3. ✅ No TAPOS_ERROR occurs when broadcasting
4. ✅ Transaction age is minimal (< 1 second from build to broadcast)

## 📝 Implementation Checklist

- [ ] Remove any block reference caching
- [ ] Fetch latest block immediately before building transaction
- [ ] Use block info synchronously (no async delays)
- [ ] Extract `ref_block_bytes` correctly (last 4 hex of block number)
- [ ] Extract `ref_block_hash` correctly (first 16 hex of txTrieRoot)
- [ ] Set expiration to current time + 60 seconds
- [ ] Set timestamp to current time
- [ ] Test with gas worker to ensure no TAPOS_ERROR

## 🔗 Integration Points

The gas worker calls the signer service with:
```typescript
{
  chain: 'tron',
  wallet_group_id: string,
  derivation_index: number,
  tx_intent: {
    type: 'send_trx',
    from: string,
    to: string,
    amount_sun: string
  }
}
```

The signer service must return:
```typescript
{
  signed_tx: string,  // Signed transaction ready for broadcast
  tx_hash?: string    // Optional: transaction hash if available
}
```

## ⚠️ Critical Notes

1. **TAPOS (Transaction as Proof of Stake)** validation requires block references to be from a recent, valid block
2. TRON blocks are produced every ~3 seconds, so block references can become stale quickly
3. The gas worker broadcasts transactions within 2-3 seconds of receiving them, so block references must be very fresh
4. If block references are stale, TRON network will reject the transaction with `TAPOS_ERROR`

## 🎯 Success Criteria

After the fix:
- ✅ Zero TAPOS_ERROR occurrences in gas worker logs
- ✅ Transactions broadcast successfully on first attempt
- ✅ Block references are always from the latest block
- ✅ Transaction build-to-broadcast time is minimal

## 📞 Questions?

If you need clarification on:
- Block reference extraction format
- TAPOS validation requirements
- Integration with gas worker
- Error handling

Please refer to the gas worker logs for detailed diagnostics, or contact the backend team.

---

**Priority:** 🔴 CRITICAL  
**Impact:** All TRON gas top-up transactions are failing  
**ETA:** Fix required immediately

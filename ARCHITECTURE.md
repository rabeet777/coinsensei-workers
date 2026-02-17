# CoinSensei Workers - Architecture Documentation

## System Overview

CoinSensei Workers is a blockchain monitoring system that detects cryptocurrency deposits to user custodial addresses and credits their off-chain balances in real-time.

```
┌─────────────────────────────────────────────────────────────┐
│                     TRON Blockchain                         │
│              (TRC20 Transfer Events)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ RPC/TronGrid API
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  TRON Deposit Worker                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  1. Fetch blocks (with confirmation threshold)       │   │
│  │  2. Parse TRC20 Transfer events                      │   │
│  │  3. Filter for user addresses                        │   │
│  │  4. Idempotent deposit insertion                     │   │
│  │  5. Credit user balances                             │   │
│  │  6. Update worker state                              │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ Supabase Service Role
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Supabase (Postgres)                      │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │  deposits        │  │  user_asset_     │                │
│  │  (UNIQUE tx+idx) │  │  balances        │                │
│  └──────────────────┘  └──────────────────┘                │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │  worker_chain_   │  │  user_wallet_    │                │
│  │  state           │  │  addresses       │                │
│  └──────────────────┘  └──────────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. TRON Client (`src/chains/tron/tron.client.ts`)

**Responsibilities:**
- Interface with TRON blockchain via TronWeb/TronGrid
- Fetch current block numbers
- Query TRC20 Transfer events by block range
- Handle RPC errors with exponential backoff
- Rate limiting and retry logic

**Key Methods:**
- `getCurrentBlockNumber()`: Get latest block
- `getTRC20Transfers()`: Fetch Transfer events for a contract
- `retryWithBackoff()`: Retry failed RPC calls

**Configuration:**
- RPC URL (from database `chains.rpc_url`)
- Confirmation threshold (from database `chains.confirmation_threshold`)

---

### 2. TRC20 Parser (`src/chains/tron/tron.usdt.parser.ts`)

**Responsibilities:**
- Parse raw TRC20 Transfer events
- Validate transfer data format
- Convert raw amounts to human-readable decimals
- Address format validation

**Key Methods:**
- `parseTransfer()`: Convert raw event to structured deposit
- `calculateHumanAmount()`: Convert wei to decimal (e.g., 1000000 → 1.0 USDT)
- `isValidTransfer()`: Validate event data
- `isValidTronAddress()`: Validate address format

---

### 3. Deposit Worker (`src/workers/deposit/tron.deposit.worker.ts`)

**Responsibilities:**
- Orchestrate the entire deposit detection flow
- Manage worker state (last processed block)
- Filter events for user addresses
- Insert deposits idempotently
- Credit user balances atomically
- Handle errors gracefully

**Workflow:**

```typescript
while (running) {
  // 1. Determine block range
  currentBlock = await client.getCurrentBlockNumber()
  safeBlock = currentBlock - confirmationThreshold
  fromBlock = lastProcessedBlock + 1
  toBlock = min(safeBlock, fromBlock + BATCH_SIZE)
  
  if (fromBlock > toBlock) {
    sleep(SCAN_INTERVAL)
    continue
  }
  
  // 2. Process each active asset
  for (asset of activeAssets) {
    transfers = await client.getTRC20Transfers(
      asset.contract,
      fromBlock,
      toBlock
    )
    
    // 3. Filter for user deposits
    for (transfer of transfers) {
      if (isUserAddress(transfer.to)) {
        // 4. Process idempotently
        if (!depositExists(transfer)) {
          insertDeposit(transfer)
          creditUserBalance(transfer)
        }
      }
    }
  }
  
  // 5. Update state
  updateLastProcessedBlock(toBlock)
  
  sleep(SCAN_INTERVAL)
}
```

---

## Database Schema

### Core Tables

#### `chains`
Blockchain network configurations (managed by platform)

```sql
id                    UUID PRIMARY KEY
name                  TEXT UNIQUE
rpc_url               TEXT
confirmation_threshold INTEGER
is_active             BOOLEAN
```

#### `assets`
Token/asset definitions (managed by platform)

```sql
id      UUID PRIMARY KEY
symbol  TEXT
name    TEXT
```

#### `asset_on_chain`
Asset deployments on specific chains (managed by platform)

```sql
id               UUID PRIMARY KEY
chain_id         UUID REFERENCES chains(id)
asset_id         UUID REFERENCES assets(id)
contract_address TEXT
decimals         INTEGER
is_active        BOOLEAN
```

#### `user_wallet_addresses`
User custodial addresses (managed by platform)

```sql
id        UUID PRIMARY KEY
user_id   UUID
chain_id  UUID REFERENCES chains(id)
address   TEXT
```

#### `user_asset_balances`
User off-chain balances (updated by worker)

```sql
user_id   UUID
asset_id  UUID REFERENCES assets(id)
balance   NUMERIC
PRIMARY KEY (user_id, asset_id)
```

### Worker Tables

#### `worker_chain_state`
Tracks last processed block per chain (managed by worker)

```sql
chain_id             UUID PRIMARY KEY REFERENCES chains(id)
last_processed_block BIGINT
updated_at           TIMESTAMPTZ
```

**Purpose:** 
- Enables restart-safe operation
- Allows monitoring of processing lag
- Supports multiple workers for different chains

#### `deposits`
Detected and processed deposits (written by worker)

```sql
id                UUID PRIMARY KEY
chain_id          UUID REFERENCES chains(id)
asset_on_chain_id UUID REFERENCES asset_on_chain(id)
tx_hash           TEXT
log_index         INTEGER
from_address      TEXT
to_address        TEXT
amount_raw        TEXT
amount_human      NUMERIC
block_number      BIGINT
block_timestamp   TIMESTAMPTZ
status            TEXT
created_at        TIMESTAMPTZ
UNIQUE (tx_hash, log_index)
```

**Purpose:**
- Idempotency via UNIQUE constraint
- Audit trail of all deposits
- Analytics and reporting
- Dispute resolution

**Indices:**
- `(tx_hash, log_index)` - UNIQUE for idempotency
- `chain_id` - filter by chain
- `to_address` - lookup user deposits
- `block_number` - time-series queries
- `created_at` - recent deposits

---

## Key Design Patterns

### 1. Idempotency

**Problem:** Worker may restart mid-processing or multiple instances may run

**Solution:** Database unique constraint + check-before-insert

```typescript
// Check if exists
const existing = await db
  .from('deposits')
  .select('id')
  .eq('tx_hash', tx)
  .eq('log_index', idx)
  .single()

if (existing) {
  return // Skip safely
}

// Insert with unique constraint
await db.from('deposits').insert({
  tx_hash: tx,
  log_index: idx,
  // ... other fields
})
// If another instance inserted simultaneously,
// unique constraint violation → gracefully skip
```

**Benefits:**
- Safe to restart at any time
- Safe to run multiple instances
- No duplicate deposits ever

### 2. Confirmation Threshold

**Problem:** Blockchain reorganizations can invalidate transactions

**Solution:** Only process blocks N confirmations deep

```typescript
currentBlock = 1000
confirmationThreshold = 19
safeBlock = 1000 - 19 = 981

// Only process up to block 981
// Wait for block 982 to have 19 confirmations
```

**Benefits:**
- Handles reorgs gracefully
- No false deposits
- Configurable per chain

### 3. Stateless Worker

**Problem:** Workers must be restart-safe

**Solution:** All state in database, no in-memory state

```typescript
// Load state from DB on startup
state = await loadWorkerState()

// Process
processBlocks(state.lastBlock + 1, safeBlock)

// Save state to DB
await saveWorkerState(safeBlock)

// If worker crashes here, next startup loads
// safeBlock and continues from there
```

**Benefits:**
- Crash-safe
- Horizontally scalable
- Easy to monitor

### 4. Batch Processing

**Problem:** Processing one block at a time is slow

**Solution:** Process blocks in configurable batches

```typescript
BATCH_SIZE = 100

fromBlock = lastProcessedBlock + 1
toBlock = min(safeBlock, fromBlock + BATCH_SIZE - 1)

// Fetch all events in range at once
events = await fetchEvents(fromBlock, toBlock)
```

**Benefits:**
- Faster synchronization
- Fewer RPC calls
- Configurable trade-off (speed vs RPC load)

### 5. User Address Filtering

**Problem:** Blockchain has millions of transfers, we only care about user deposits

**Solution:** In-memory address map for fast lookup

```typescript
// Load on startup
userAddresses = new Map()
addresses = await db.from('user_wallet_addresses').select('*')
for (addr of addresses) {
  userAddresses.set(addr.address.toLowerCase(), addr)
}

// Fast O(1) lookup during processing
for (transfer of transfers) {
  user = userAddresses.get(transfer.to.toLowerCase())
  if (user) {
    processDeposit(transfer, user)
  }
}
```

**Benefits:**
- Fast filtering (O(1) vs O(n) DB query per event)
- Reduces DB load dramatically
- Reloadable without restart

---

## Data Flow

### Deposit Detection Flow

```
1. Worker starts
   ├─→ Load chain config from DB
   ├─→ Load active assets from DB
   ├─→ Load user addresses into memory map
   └─→ Load last processed block from DB

2. Scanning loop
   ├─→ Get current block from TRON
   ├─→ Calculate safe block (current - confirmations)
   ├─→ Determine block range to scan
   │
   └─→ For each active asset:
       ├─→ Fetch TRC20 Transfer events
       │
       └─→ For each transfer:
           ├─→ Validate transfer data
           ├─→ Check if to_address is a user address
           │   └─→ If yes:
           │       ├─→ Check if deposit already exists
           │       │   └─→ If yes: skip
           │       │   └─→ If no:
           │       │       ├─→ Insert into deposits table
           │       │       └─→ Credit user_asset_balances
           │
           └─→ Continue

3. Update state
   └─→ Save last_processed_block to DB

4. Sleep and repeat
```

### Balance Crediting Flow

```
Deposit detected
   │
   ├─→ Check if user has balance record
   │   ├─→ If yes: UPDATE balance = balance + amount
   │   └─→ If no:  INSERT (user_id, asset_id, amount)
   │
   └─→ Log credit event
```

---

## Error Handling Strategy

### RPC Errors

```typescript
try {
  return await tronClient.getCurrentBlock()
} catch (error) {
  // Retry with exponential backoff
  for (attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await sleep(baseMs * 2^attempt)
    try {
      return await tronClient.getCurrentBlock()
    } catch (error) {
      if (attempt === MAX_RETRIES - 1) throw
    }
  }
}
```

**Handled:**
- Network timeouts
- Rate limits (429)
- Temporary RPC failures

**Not Handled:**
- Invalid RPC URL (fail fast on startup)
- Authentication errors (fail fast)

### Database Errors

```typescript
try {
  await db.from('deposits').insert(deposit)
} catch (error) {
  if (error.code === '23505') { // Unique violation
    // Another worker inserted it, skip gracefully
    logger.debug('Duplicate deposit, skipping')
    return
  }
  throw error // Other errors propagate
}
```

**Handled:**
- Unique constraint violations (idempotency)
- Connection timeouts (retry at worker level)

**Not Handled:**
- Schema errors (fail fast)
- Permission errors (fail fast)

### Partial Failures

```typescript
try {
  processBlockRange(fromBlock, toBlock)
  await updateWorkerState(toBlock) // Only update if successful
} catch (error) {
  logger.error('Failed to process blocks, not updating state')
  // State not updated, will retry on next iteration
}
```

**Strategy:** Conservative state updates - only advance state on complete success

---

## Performance Characteristics

### Throughput

**Theoretical Maximum:**
- TRON: ~3 second block time
- With 19 confirmations: ~57 second lag
- 100 blocks/batch: ~5 minutes of history per batch
- At 10s scan interval: Can process ~30 blocks/minute

**Bottlenecks:**
1. RPC rate limits (TronGrid free tier)
2. Database write speed (usually not a bottleneck)
3. Number of user addresses (O(1) lookup, not a bottleneck)

### Latency

**Deposit Detection Time:**
- Block inclusion: ~3 seconds
- Confirmations (19 blocks): ~57 seconds
- Worker scan lag: ~10 seconds average
- **Total: ~70 seconds** from broadcast to credit

**Can be reduced by:**
- Lowering confirmation threshold (less secure)
- Decreasing scan interval (more RPC calls)
- Using block subscription instead of polling (requires TronGrid Pro)

### Resource Usage

**Memory:**
- Base: ~50 MB
- + ~1 KB per user address
- + ~10 KB per active asset
- **Typical: <100 MB**

**CPU:**
- Idle: <1%
- During scan: 5-10%
- **Average: ~2%**

**Database:**
- ~1-10 queries per scan interval
- ~1 insert per deposit
- Minimal load

**Network:**
- ~1-5 RPC calls per scan
- ~10 KB per RPC call
- **~1-5 KB/s average**

---

## Security Considerations

### Threat Model

**In Scope:**
- Deposit detection accuracy
- Idempotency guarantees
- Data integrity
- Service availability

**Out of Scope (handled elsewhere):**
- Wallet generation (Vault service)
- Private key management (Vault service)
- Withdrawals (separate service)
- User authentication (API service)

### Security Properties

1. **Read-Only Blockchain Access**
   - Worker never writes to blockchain
   - No private keys in worker
   - Cannot sign transactions

2. **Service Role Access**
   - Uses Supabase SERVICE ROLE
   - Full database access required
   - Key stored in environment (not code)
   - Key should be rotated regularly

3. **No User PII**
   - Only blockchain public data
   - User IDs are references, not personal data
   - Safe to log addresses and amounts

4. **Injection Prevention**
   - Supabase client parameterizes queries
   - No raw SQL with user input
   - Contract addresses validated on insert

### Operational Security

1. **Environment Variables**
   - Never commit .env to version control
   - Use secret management (Vault, AWS Secrets, etc.)
   - Rotate credentials regularly

2. **Monitoring**
   - Alert on processing lag
   - Alert on error rate spikes
   - Monitor for anomalous deposit amounts

3. **Incident Response**
   - False deposit detected → investigate immediately
   - Missing deposits → check RPC, review logs
   - Duplicate deposits → should never happen, escalate

---

## Future Enhancements

### Short Term
- [ ] Add more TRC20 tokens (USDC, etc.)
- [ ] Webhook notifications for deposits
- [ ] Prometheus metrics export
- [ ] Health check endpoint

### Medium Term
- [ ] BullMQ integration for distributed processing
- [ ] Support for TRC721 (NFT) deposits
- [ ] Multi-chain support (Ethereum, BSC, Polygon)
- [ ] Deposit amount thresholds and alerting

### Long Term
- [ ] Real-time WebSocket subscriptions (instead of polling)
- [ ] Machine learning for fraud detection
- [ ] Cross-chain bridge monitoring
- [ ] Automated gas fee optimization

---

## Testing Strategy

### Unit Tests (TODO)
- TRC20 parser validation
- Amount calculation accuracy
- Address format validation
- Error handling logic

### Integration Tests (TODO)
- Database operations
- RPC client retry logic
- End-to-end deposit flow (testnet)

### Production Testing
1. Deploy to testnet first (Nile)
2. Send test deposits
3. Verify detection and crediting
4. Monitor for 24 hours
5. Deploy to mainnet

---

## Comparison with Alternatives

### vs Block Subscription (WebSockets)

**Polling (Current):**
- ✅ Simple, stateless
- ✅ Easy to restart
- ✅ Works with any RPC provider
- ❌ Higher latency (~10s)
- ❌ More RPC calls

**Subscription:**
- ✅ Lower latency (real-time)
- ✅ Fewer RPC calls
- ❌ Requires WebSocket support
- ❌ More complex error handling
- ❌ Harder to make stateless

**Verdict:** Polling is appropriate for current scale. Switch to subscriptions if latency becomes critical.

### vs Event Indexer (The Graph, etc.)

**Custom Worker (Current):**
- ✅ Full control
- ✅ No third-party dependency
- ✅ Simpler deployment
- ❌ Must maintain ourselves

**Indexer Service:**
- ✅ Scalable querying
- ✅ GraphQL interface
- ❌ Additional cost
- ❌ Vendor lock-in
- ❌ Overkill for simple use case

**Verdict:** Custom worker appropriate. Reconsider if we need complex queries or analytics.

---

## Maintenance

### Regular Tasks
- **Daily:** Review logs, check processing lag
- **Weekly:** Verify deposit accuracy, review error rates
- **Monthly:** Update dependencies, review performance
- **Quarterly:** Security audit, disaster recovery test

### Monitoring Checklist
- [ ] Worker is running
- [ ] Processing lag < 5 minutes
- [ ] No error spikes in last 24h
- [ ] Deposits being credited correctly
- [ ] Database connections healthy
- [ ] RPC endpoint responsive

---

## Glossary

- **Confirmation Threshold:** Number of blocks to wait before considering a transaction final
- **Safe Block:** Latest block minus confirmation threshold
- **Worker State:** Last successfully processed block number
- **Idempotency:** Property ensuring an operation can be applied multiple times without changing the result
- **TRC20:** TRON token standard (similar to ERC20 on Ethereum)
- **Service Role:** Supabase admin key with full database access
- **RPC:** Remote Procedure Call - API for interacting with blockchain nodes
- **Block Reorganization:** When blockchain replaces recent blocks with alternative chain


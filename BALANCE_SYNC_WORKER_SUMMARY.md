# Balance Sync Worker - Native + Token Asset Support

## Overview

The Balance Sync Worker has been updated to sync **BOTH native assets** (TRX, BNB, ETH) and **token assets** (USDT, USDC, etc.) in a fully data-driven way.

## Key Features

### 1. Data-Driven Asset Discovery

- Loads assets from `asset_on_chain` table
- No hardcoded asset symbols or checks
- Processes assets based on `is_native` flag
- Only syncs active assets (`is_active = true`)

### 2. Native Asset Balance Sync

For assets where `asset_on_chain.is_native = true`:

**TRON:**
- Uses `tronWeb.trx.getBalance(address)`
- Returns balance in SUN (1 TRX = 1,000,000 SUN)
- Converts using `asset_on_chain.decimals`

**BSC/EVM:**
- Uses `provider.getBalance(address)`
- Returns balance in WEI (1 BNB = 10^18 WEI)
- Converts using `asset_on_chain.decimals`

### 3. Token Asset Balance Sync

For assets where `asset_on_chain.is_native = false`:

**TRON (TRC20):**
- Uses `triggerConstantContract()` with `balanceOf(address)`
- Requires `asset_on_chain.contract_address`
- Converts using `asset_on_chain.decimals`

**BSC/EVM (BEP20/ERC20):**
- Uses ethers.js Contract with `balanceOf(address)`
- Requires `asset_on_chain.contract_address`
- Converts using `asset_on_chain.decimals`

## Database Updates

### Fields Updated (ONLY)

The worker updates **ONLY** these fields in `wallet_balances`:

✅ `on_chain_balance_raw` - Raw balance from blockchain  
✅ `on_chain_balance_human` - Human-readable balance  
✅ `last_checked` - Timestamp of last sync  
✅ `sync_count` - Incremented on each successful sync  
✅ `updated_at` - Timestamp of last update  

### Fields NOT Touched

The worker **NEVER** modifies:

❌ `needs_gas` - Managed by Rule Execution Worker  
❌ `needs_consolidation` - Managed by Rule Execution Worker  
❌ `priority` - Managed by Rule Execution Worker  
❌ `gas_locked_until` / `gas_locked_by` - Managed by Gas Workers  
❌ `consolidation_locked_until` / `consolidation_locked_by` - Managed by Consolidation Workers  

## Error Handling

- If balance fetch fails for an asset:
  - Increments `wallet_balances.error_count`
  - Sets `last_error` and `last_error_at`
  - Continues processing other assets
  - Does NOT stop the worker

## Worker Flow

```
1. Select idle wallet_balances rows (batch of 50)
2. Lock rows for processing
3. For each row:
   a. Load asset_on_chain configuration
   b. Load chain configuration
   c. Load wallet address for chain
   d. Determine asset type (native vs token)
   e. Fetch balance from blockchain
   f. Convert to human-readable format
   g. Update wallet_balances
   h. Release lock
4. Sleep 30 seconds
5. Repeat
```

## Key Improvements

### Fixed Wallet Address Lookup

**Before:**
```typescript
.eq('id', row.wallet_id)  // ❌ Wrong column
```

**After:**
```typescript
.eq('wallet_id', row.wallet_id)
.eq('chain_id', assetOnChain.chain_id)
.eq('is_active', true)
```

### Separated Lock Management

- `updateBalance()` - Updates balance fields only
- `releaseLock()` - Releases processing lock separately
- Clean separation of concerns

### Enhanced Logging

- Logs asset type (native vs token)
- Shows asset_id and contract_address
- Helps debug balance sync issues

## Configuration

### Environment Variables

```bash
SUPABASE_URL=<your-supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<your-key>
```

### Worker Settings

- `BATCH_SIZE`: 50 rows per batch
- `LOCK_DURATION_SECONDS`: 120 seconds (2 minutes)
- `SYNC_INTERVAL_MS`: 30000 ms (30 seconds)

## Running the Worker

```bash
# Development
npm run dev:balance-sync

# Production
npm run start:balance-sync
```

## Guarantees

✅ Worker is **READ-ONLY** with respect to system state  
✅ Never sets `needs_gas` or `needs_consolidation`  
✅ Never acquires gas or consolidation locks  
✅ Never enqueues jobs  
✅ Only updates balance-related fields  

## Database Schema Requirements

### asset_on_chain

Required columns:
- `id` (primary key)
- `chain_id` (foreign key to chains)
- `asset_id` (foreign key to assets)
- `contract_address` (nullable, required for tokens)
- `decimals` (integer, e.g., 6 for USDT, 18 for BNB)
- `is_native` (boolean, true for TRX/BNB/ETH)
- `is_active` (boolean, only active assets are synced)

### wallet_balances

Required columns:
- `id` (primary key)
- `wallet_id` (foreign key)
- `asset_on_chain_id` (foreign key)
- `on_chain_balance_raw` (string, raw balance)
- `on_chain_balance_human` (string, human-readable)
- `last_checked` (timestamp)
- `sync_count` (integer)
- `error_count` (integer)
- `last_error` (text)
- `last_error_at` (timestamp)
- `processing_status` (enum: idle/processing)
- `locked_until` (timestamp)
- `locked_by` (string, worker ID)

### user_wallet_addresses

Required columns:
- `wallet_id` (foreign key)
- `chain_id` (foreign key)
- `address` (string, blockchain address)
- `is_active` (boolean)

### chains

Required columns:
- `id` (primary key)
- `name` (string, e.g., 'tron', 'bsc')
- `rpc_url` (string)
- `is_active` (boolean)

## Testing

1. Ensure database has:
   - Active chains with valid RPC URLs
   - Active assets in `asset_on_chain`
   - Wallet addresses in `user_wallet_addresses`
   - Wallet balance rows in `wallet_balances`

2. Start the worker:
   ```bash
   npm run dev:balance-sync
   ```

3. Check logs for:
   - "Fetched native asset balance" (for TRX, BNB, etc.)
   - "Fetched token asset balance" (for USDT, etc.)
   - "Wallet balance synced successfully"

4. Verify database:
   - `on_chain_balance_raw` and `on_chain_balance_human` updated
   - `last_checked` timestamp updated
   - `sync_count` incremented

## Architecture Compliance

This worker follows the CoinSensei architecture:

- ✅ **Separation of Concerns**: Only syncs balances, doesn't make decisions
- ✅ **Data-Driven**: No hardcoded asset symbols or chains
- ✅ **Idempotent**: Safe to run multiple times
- ✅ **Fault-Tolerant**: Continues on errors, increments error_count
- ✅ **Observable**: Comprehensive logging for debugging
- ✅ **Scalable**: Processes in batches, can run multiple instances

## Future Enhancements

Potential improvements (not currently implemented):

- [ ] Parallel balance fetching for multiple assets
- [ ] Adaptive batch sizing based on error rates
- [ ] Prometheus metrics for monitoring
- [ ] Balance change notifications/webhooks
- [ ] Historical balance tracking

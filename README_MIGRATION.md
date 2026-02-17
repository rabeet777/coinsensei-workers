# Quick Migration Guide

## Before Running the Updated Worker

### Step 1: Run the New Migration

```bash
psql $DATABASE_URL -f migrations/002_credit_balance_function.sql
```

Or execute in Supabase SQL Editor:

```sql
CREATE OR REPLACE FUNCTION credit_user_asset_balance(
  p_uid UUID,
  p_asset_id UUID,
  p_amount NUMERIC
) RETURNS void AS $$
BEGIN
  INSERT INTO user_asset_balance (uid, asset_id, available_balance_human)
  VALUES (p_uid, p_asset_id, p_amount)
  ON CONFLICT (uid, asset_id)
  DO UPDATE SET
    available_balance_human = user_asset_balance.available_balance_human + p_amount;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION credit_user_asset_balance(UUID, UUID, NUMERIC) TO authenticated;
```

### Step 2: Verify Your Schema

Make sure your database has:

**Table: `user_wallet_addresses`**
- Column: `uid` (not `user_id`)

**Table: `user_asset_balance`** (singular, not plural!)
- Column: `available_balance_human` (not `balance`)

**Table: `deposits`**
- Unique constraint: `(tx_hash, log_index)`

**Table: `worker_chain_state`**
- Standard structure (no changes)

### Step 3: Restart the Worker

```bash
# Stop old worker
pkill -f "tsx src/index.ts"

# Start new worker
npm start
```

## What Changed?

1. ✅ **Fixed column name**: `user_id` → `uid`
2. ✅ **Fixed table name**: `user_asset_balances` → `user_asset_balance`
3. ✅ **Fixed column name**: `balance` → `available_balance_human`
4. ✅ **No more JS math**: Balance operations now use Postgres function
5. ✅ **Better error handling**: `.single()` → `.maybeSingle()`
6. ✅ **Hardened idempotency**: Explicit error checks
7. ✅ **Renamed parser**: `TronUSDTParser` → `TronTRC20TransferParser`

## Testing

Send a test deposit and verify:
- Deposit appears in `deposits` table
- Balance updated in `user_asset_balance` table
- No precision errors (check decimal places)
- Worker logs show success

## Need Help?

See `FIXES_APPLIED.md` for detailed documentation of all changes.


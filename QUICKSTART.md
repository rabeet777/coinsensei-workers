# QuickStart Guide

Get the TRON deposit worker running in 5 minutes.

## Prerequisites

- Node.js 18+ installed
- Supabase project with service role key
- TRON RPC access (default: TronGrid public API)

## Step 1: Install Dependencies

```bash
npm install
```

## Step 2: Create Environment File

Create `.env` file in the project root:

```bash
# Supabase Configuration (REQUIRED)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...your-service-role-key

# Worker Configuration (Optional - defaults provided)
NODE_ENV=production
LOG_LEVEL=info
BATCH_BLOCK_SIZE=100
SCAN_INTERVAL_MS=10000
```

## Step 3: Run Database Migration

Execute the migration SQL in your Supabase SQL Editor or via psql:

```bash
psql $DATABASE_URL -f migrations/001_create_worker_tables.sql
```

Or copy/paste the SQL from `migrations/001_create_worker_tables.sql` into Supabase dashboard.

## Step 4: Configure TRON Chain (One-time)

Run this SQL in Supabase to add TRON chain configuration:

```sql
-- Insert TRON chain
INSERT INTO chains (id, name, rpc_url, confirmation_threshold, is_active)
VALUES (
  gen_random_uuid(),
  'tron',
  'https://api.trongrid.io',
  19,
  true
)
ON CONFLICT (name) DO NOTHING;
```

## Step 5: Configure USDT Asset (One-time)

Add USDT asset and TRC20 configuration:

```sql
-- Insert USDT asset (if not exists)
INSERT INTO assets (id, symbol, name)
SELECT gen_random_uuid(), 'USDT', 'Tether USD'
WHERE NOT EXISTS (SELECT 1 FROM assets WHERE symbol = 'USDT');

-- Insert TRC20 USDT on TRON
INSERT INTO asset_on_chain (
  id,
  chain_id,
  asset_id,
  contract_address,
  decimals,
  is_active
)
SELECT
  gen_random_uuid(),
  (SELECT id FROM chains WHERE name = 'tron'),
  (SELECT id FROM assets WHERE symbol = 'USDT'),
  'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  6,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM asset_on_chain
  WHERE chain_id = (SELECT id FROM chains WHERE name = 'tron')
  AND contract_address = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
);
```

## Step 6: Add User Wallet Address (For Testing)

Add a TRON address to monitor:

```sql
-- Insert a test user wallet address
INSERT INTO user_wallet_addresses (
  id,
  user_id,
  chain_id,
  address
)
VALUES (
  gen_random_uuid(),
  'your-user-id-here',  -- Replace with actual user ID
  (SELECT id FROM chains WHERE name = 'tron'),
  'TYourTronAddressHere'  -- Replace with actual TRON address
);

-- Ensure user has balance record
INSERT INTO user_asset_balances (
  user_id,
  asset_id,
  balance
)
SELECT
  'your-user-id-here',  -- Replace with actual user ID
  (SELECT id FROM assets WHERE symbol = 'USDT'),
  '0'
WHERE NOT EXISTS (
  SELECT 1 FROM user_asset_balances
  WHERE user_id = 'your-user-id-here'
  AND asset_id = (SELECT id FROM assets WHERE symbol = 'USDT')
);
```

## Step 7: Start the Worker

```bash
npm start
```

You should see output like:

```
🚀 Starting CoinSensei Workers...
INFO: Initializing TRON deposit worker...
INFO: Loaded TRON chain configuration
INFO: Loaded active TRC20 assets
INFO: Loaded user wallet addresses
INFO: TRON deposit worker initialized successfully
INFO: Starting TRON deposit worker loop
INFO: Scanning block range for deposits
```

## Verify It's Working

1. **Check Logs**: Worker should log block scanning activity every 10 seconds
2. **Check Database**: `worker_chain_state` table should show increasing `last_processed_block`
3. **Send Test Deposit**: Send USDT to your configured address and watch for deposit detection
4. **Check Deposits**: Query `deposits` table to see detected deposits
5. **Check Balance**: Query `user_asset_balances` to see credited amounts

## Testing Deposit Detection

Send a small USDT amount to your configured address:

```
To: TYourTronAddressHere
Amount: 1 USDT (or any amount)
Network: TRON (TRC20)
```

After ~19 confirmations (about 1 minute), you should see:

```
INFO: Deposit processed and credited {
  txHash: "...",
  user: "your-user-id",
  amount: "1.0",
  asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
}
```

## Troubleshooting

### "Missing required environment variables"
- Ensure `.env` file exists with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

### "Failed to load TRON chain config"
- Ensure Step 4 (Configure TRON Chain) was completed
- Verify chain `is_active = true`

### "Failed to load active assets"
- Ensure Step 5 (Configure USDT Asset) was completed
- Verify asset_on_chain `is_active = true`

### "No new confirmed blocks to process"
- This is normal - worker is waiting for new blocks
- Will log every 10 seconds

### RPC Errors
- TronGrid public API has rate limits
- Consider using a paid TronGrid API key for production
- Update `rpc_url` in chains table

### Deposits Not Detected
- Ensure address is in `user_wallet_addresses` table
- Ensure address matches exactly (case-sensitive)
- Wait for confirmation threshold (19 blocks ≈ 1 minute)
- Check logs for any errors

## Next Steps

- Monitor worker with systemd/pm2 for production
- Set up alerting for errors
- Scale to multiple workers if needed
- Add more assets/chains as needed

## Support

For issues, check:
1. Worker logs (increase LOG_LEVEL=debug for verbose output)
2. Database table states
3. TRON block explorer for transaction status


# CoinSensei Workers

Production-grade blockchain deposit listener workers for CoinSensei platform.

## Features

- **TRON TRC20 Deposit Listener**: Monitors TRON blockchain for USDT deposits to user custodial addresses
- **Idempotent Processing**: Safe to restart, no duplicate deposits
- **Stateless Architecture**: Restart-safe with database-persisted state
- **Configurable**: All chain and asset configurations loaded from database
- **Production-Ready**: Comprehensive error handling, logging, and retry logic

## Architecture

### Workers

- **TRON Deposit Worker**: Scans confirmed TRON blocks for TRC20 Transfer events, filters deposits to user addresses, and credits off-chain balances

### Database Tables

#### Existing Tables
- `chains`: Blockchain network configurations
- `assets`: Token/asset definitions
- `asset_on_chain`: Asset deployments on specific chains
- `user_wallet_addresses`: User custodial addresses
- `user_asset_balances`: User off-chain balances

#### Worker Tables (Created by Migration)
- `worker_chain_state`: Tracks last processed block per chain
- `deposits`: Stores detected deposits with idempotency guarantee

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Database Migration

Run the SQL migration to create worker tables:

```bash
psql $DATABASE_URL -f migrations/001_create_worker_tables.sql
```

Or execute via Supabase dashboard SQL editor.

### 3. Configure Environment

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required environment variables:

```env
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Worker Configuration
NODE_ENV=production
LOG_LEVEL=info

# Block Scanning Configuration
BATCH_BLOCK_SIZE=100
SCAN_INTERVAL_MS=10000
```

### 4. Configure Chain in Database

Ensure TRON chain exists in `chains` table:

```sql
INSERT INTO chains (id, name, rpc_url, confirmation_threshold, is_active)
VALUES (
  gen_random_uuid(),
  'tron',
  'https://api.trongrid.io',
  19,
  true
);
```

### 5. Configure Assets in Database

Add TRC20 USDT to `asset_on_chain` table:

```sql
-- First, ensure asset exists in assets table
INSERT INTO assets (id, symbol, name)
VALUES (gen_random_uuid(), 'USDT', 'Tether USD');

-- Then add to asset_on_chain
INSERT INTO asset_on_chain (id, chain_id, asset_id, contract_address, decimals, is_active)
VALUES (
  gen_random_uuid(),
  (SELECT id FROM chains WHERE name = 'tron'),
  (SELECT id FROM assets WHERE symbol = 'USDT'),
  'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',  -- USDT TRC20 contract
  6,
  true
);
```

## Running

### Development Mode (with auto-reload)

```bash
npm run dev
```

### Production Mode

```bash
npm start
```

## How It Works

### Startup Phase

1. Loads TRON chain configuration from `chains` table
2. Loads active TRC20 assets from `asset_on_chain` table
3. Loads user wallet addresses from `user_wallet_addresses` table
4. Initializes worker state in `worker_chain_state` table

### Scanning Loop

1. **Block Range Selection**:
   - Gets current block from TRON network
   - Calculates safe block: `current_block - confirmation_threshold`
   - Scans from `last_processed_block + 1` to `safe_block`
   - Batches blocks to avoid overload

2. **Event Fetching**:
   - Fetches TRC20 Transfer events for each active asset
   - Uses TronWeb/TronGrid API with retry logic
   - Respects rate limits with backoff

3. **Filtering**:
   - Extracts transfer details (from, to, amount, block, etc.)
   - Filters for deposits to user addresses only
   - Validates transfer data format

4. **Idempotent Processing**:
   - Checks if deposit exists by `(tx_hash, log_index)`
   - Skips if already processed
   - Handles race conditions safely

5. **Deposit Processing**:
   - Inserts into `deposits` table
   - Credits user balance in `user_asset_balances`
   - Logs all operations

6. **State Update**:
   - Updates `worker_chain_state.last_processed_block`
   - Only advances after successful processing

7. **Sleep & Repeat**:
   - Sleeps for configured interval (default: 10 seconds)
   - Repeats indefinitely

## Error Handling

- **RPC Errors**: Automatic retry with exponential backoff
- **Database Conflicts**: Safely skips duplicate deposits
- **Partial Failures**: Does not advance state, retries on next iteration
- **Worker Crash**: Restarts safely from last processed block

## Security

- Uses Supabase SERVICE ROLE for database access
- Never generates wallets or derives keys
- Never signs transactions
- Never interacts with Vault
- Logs only public blockchain data

## Production Considerations

### Monitoring

Monitor these metrics:
- Last processed block vs current block (lag indicator)
- Deposits processed per hour
- Error rates and types
- Worker uptime

### Scaling

- Run multiple worker instances safely (idempotency guarantees no duplicates)
- Consider sharding by asset for high throughput
- Use BullMQ for distributed job processing (architecture supports this)

### Performance Tuning

- Adjust `BATCH_BLOCK_SIZE` based on RPC performance
- Adjust `SCAN_INTERVAL_MS` based on block time and confirmation requirements
- Consider caching user addresses for faster lookup

## Future Enhancements

- BullMQ integration for distributed processing
- Multi-chain support (add EVM chains, Solana, etc.)
- Webhook notifications for deposits
- Deposit amount thresholds and alerting
- Admin dashboard for monitoring

## License

Proprietary - CoinSensei Platform


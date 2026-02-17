-- Debug script to check worker configuration and recent deposits

-- 1. Check worker state
SELECT 
  'Worker State' as check_type,
  last_processed_block,
  updated_at,
  EXTRACT(EPOCH FROM (NOW() - updated_at)) as seconds_since_update
FROM worker_chain_state
WHERE chain_id = (SELECT id FROM chains WHERE name = 'tron');

-- 2. Check monitored addresses
SELECT 
  'Monitored Addresses' as check_type,
  address,
  id as user_identifier
FROM user_wallet_addresses
WHERE chain_id = (SELECT id FROM chains WHERE name = 'tron');

-- 3. Check if any deposits were recorded
SELECT 
  'Recent Deposits' as check_type,
  COUNT(*) as total_deposits,
  MAX(block_number) as highest_block,
  MAX(created_at) as latest_deposit
FROM deposits
WHERE chain_id = (SELECT id FROM chains WHERE name = 'tron');

-- 4. Show all deposits (if any)
SELECT 
  tx_hash,
  to_address,
  amount_human,
  block_number,
  block_timestamp,
  created_at
FROM deposits
WHERE chain_id = (SELECT id FROM chains WHERE name = 'tron')
ORDER BY block_number DESC
LIMIT 20;

-- 5. Check chain and asset configuration
SELECT 
  'Chain Config' as check_type,
  c.name as chain_name,
  c.rpc_url,
  c.confirmation_threshold,
  a.symbol as asset_symbol,
  aoc.contract_address,
  aoc.decimals,
  aoc.is_active
FROM chains c
JOIN asset_on_chain aoc ON aoc.chain_id = c.id
JOIN assets a ON a.id = aoc.asset_id
WHERE c.name = 'tron';


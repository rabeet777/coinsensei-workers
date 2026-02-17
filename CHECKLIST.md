# CoinSensei Workers - Deployment Checklist

Use this checklist to ensure proper setup and deployment.

## Pre-Deployment Checklist

### 1. Development Environment Setup

- [ ] Node.js 18+ installed
- [ ] npm installed
- [ ] Git repository cloned
- [ ] Dependencies installed: `npm install`
- [ ] TypeScript compiles: `npm run build`
- [ ] Setup verified: `npm run verify`

### 2. Database Setup

- [ ] Supabase project created
- [ ] Database migration executed (`migrations/001_create_worker_tables.sql`)
- [ ] Tables created successfully:
  - [ ] `worker_chain_state`
  - [ ] `deposits`
- [ ] Indexes created successfully
- [ ] Unique constraints in place

### 3. Chain Configuration

- [ ] TRON chain added to `chains` table:
  ```sql
  INSERT INTO chains (id, name, rpc_url, confirmation_threshold, is_active)
  VALUES (
    gen_random_uuid(),
    'tron',
    'https://api.trongrid.io',  -- Or your paid RPC URL
    19,
    true
  );
  ```
- [ ] Chain `is_active = true`
- [ ] RPC URL tested and working
- [ ] Confirmation threshold configured (recommended: 19)

### 4. Asset Configuration

- [ ] USDT asset added to `assets` table:
  ```sql
  INSERT INTO assets (id, symbol, name)
  VALUES (gen_random_uuid(), 'USDT', 'Tether USD')
  ON CONFLICT (symbol) DO NOTHING;
  ```
- [ ] TRC20 USDT added to `asset_on_chain` table:
  ```sql
  INSERT INTO asset_on_chain (
    id, chain_id, asset_id, contract_address, decimals, is_active
  )
  SELECT
    gen_random_uuid(),
    (SELECT id FROM chains WHERE name = 'tron'),
    (SELECT id FROM assets WHERE symbol = 'USDT'),
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    6,
    true;
  ```
- [ ] Contract address correct (mainnet vs testnet)
- [ ] Decimals correct (USDT = 6)
- [ ] Asset `is_active = true`

### 5. User Addresses

- [ ] User wallet addresses added to `user_wallet_addresses` table
- [ ] Addresses are valid TRON format (start with 'T')
- [ ] `chain_id` references TRON chain
- [ ] User IDs are valid references

### 6. Environment Configuration

- [ ] `.env` file created (from `.env.example`)
- [ ] `SUPABASE_URL` configured
- [ ] `SUPABASE_SERVICE_ROLE_KEY` configured
- [ ] Optional variables configured:
  - [ ] `NODE_ENV` (production recommended)
  - [ ] `LOG_LEVEL` (info recommended)
  - [ ] `BATCH_BLOCK_SIZE` (100 default)
  - [ ] `SCAN_INTERVAL_MS` (10000 default)
- [ ] `.env` file NOT committed to Git (in `.gitignore`)

### 7. Security Checklist

- [ ] Service role key stored securely (not in code)
- [ ] Environment variables not exposed in logs
- [ ] `.env` file in `.gitignore`
- [ ] Firewall rules configured for database access
- [ ] Worker runs with minimal necessary permissions
- [ ] No private keys in worker (read-only blockchain access)

## Testing Checklist (Testnet)

### 8. Testnet Deployment

- [ ] Update chain RPC to testnet (Nile):
  ```sql
  UPDATE chains 
  SET rpc_url = 'https://nile.trongrid.io'
  WHERE name = 'tron';
  ```
- [ ] Update USDT contract to testnet address
- [ ] Worker starts without errors
- [ ] Worker initializes successfully
- [ ] Worker begins scanning blocks
- [ ] No error spikes in logs

### 9. Testnet Testing

- [ ] Send test USDT deposit to configured address
- [ ] Wait for confirmations (~19 blocks, ~1 minute)
- [ ] Check logs for deposit detection
- [ ] Verify deposit in `deposits` table
- [ ] Verify balance credited in `user_asset_balances`
- [ ] Send duplicate transaction (test idempotency)
- [ ] Restart worker (test restart safety)
- [ ] Verify no duplicate deposits

### 10. Testnet Monitoring

- [ ] Worker state updates regularly
- [ ] Processing lag < 5 minutes
- [ ] No error patterns in logs
- [ ] Memory usage stable (<200 MB)
- [ ] CPU usage reasonable (<10%)

## Production Deployment Checklist

### 11. Production Database Setup

- [ ] Switch to mainnet RPC:
  ```sql
  UPDATE chains 
  SET rpc_url = 'https://api.trongrid.io'  -- Or paid provider
  WHERE name = 'tron';
  ```
- [ ] Use mainnet USDT contract address
- [ ] Production user addresses configured
- [ ] Database backups enabled (Supabase automatic)
- [ ] Connection pooling configured

### 12. Production Environment

- [ ] Production `.env` configured
- [ ] `NODE_ENV=production`
- [ ] Service role key from secure storage
- [ ] Consider paid RPC provider (higher rate limits)
- [ ] Server resources adequate (1GB RAM minimum)

### 13. Process Management

Choose one deployment method:

#### Option A: PM2
- [ ] PM2 installed globally
- [ ] `ecosystem.config.js` created
- [ ] Worker started: `pm2 start ecosystem.config.js`
- [ ] Process saved: `pm2 save`
- [ ] Startup script configured: `pm2 startup`
- [ ] Logs accessible: `pm2 logs`

#### Option B: systemd
- [ ] Service file created: `/etc/systemd/system/coinsensei-worker.service`
- [ ] Service enabled: `systemctl enable coinsensei-worker`
- [ ] Service started: `systemctl start coinsensei-worker`
- [ ] Logs accessible: `journalctl -u coinsensei-worker`

#### Option C: Docker
- [ ] Dockerfile created
- [ ] docker-compose.yml configured
- [ ] Image built
- [ ] Container running: `docker-compose up -d`
- [ ] Logs accessible: `docker-compose logs`

#### Option D: Kubernetes
- [ ] Deployment manifest created
- [ ] Secrets configured
- [ ] Deployment applied
- [ ] Pod running
- [ ] Logs accessible: `kubectl logs`

### 14. Monitoring Setup

- [ ] Log aggregation configured (optional):
  - [ ] Datadog / CloudWatch / Elasticsearch
- [ ] Metrics collection (optional):
  - [ ] Prometheus / Grafana
- [ ] Health checks configured
- [ ] Alerts configured:
  - [ ] Processing lag > 5 minutes
  - [ ] Worker not running
  - [ ] Error rate spike
  - [ ] Memory usage high

### 15. Operational Readiness

- [ ] Runbook created for common issues
- [ ] Incident response plan documented
- [ ] On-call schedule defined
- [ ] Backup restoration tested
- [ ] Disaster recovery plan documented
- [ ] Team trained on operations

## Post-Deployment Checklist

### 16. Validation

- [ ] Worker running and processing blocks
- [ ] `worker_chain_state` updating regularly
- [ ] Real deposits being detected
- [ ] Balances being credited correctly
- [ ] No error spikes in logs
- [ ] Processing lag acceptable (<5 min)

### 17. Production Testing

- [ ] Send small real deposit to test address
- [ ] Verify detection and crediting
- [ ] Monitor for 24 hours
- [ ] Review all logs
- [ ] Check for any anomalies

### 18. Documentation

- [ ] Deployment documented (who, when, what)
- [ ] Configuration documented
- [ ] Monitoring dashboards documented
- [ ] Runbook updated with production details
- [ ] Team notified of deployment

## Ongoing Maintenance Checklist

### Daily Tasks
- [ ] Review logs for errors
- [ ] Check processing lag
- [ ] Verify deposits being detected
- [ ] Monitor resource usage

### Weekly Tasks
- [ ] Review deposit accuracy
- [ ] Check error rate trends
- [ ] Review performance metrics
- [ ] Verify backup integrity

### Monthly Tasks
- [ ] Update dependencies: `npm update`
- [ ] Review security advisories
- [ ] Performance optimization review
- [ ] Documentation updates

### Quarterly Tasks
- [ ] Security audit
- [ ] Disaster recovery test
- [ ] Capacity planning review
- [ ] Team training refresh

## Troubleshooting Reference

### Worker Won't Start

1. [ ] Check environment variables
2. [ ] Verify database connectivity
3. [ ] Check chain configuration
4. [ ] Review startup logs
5. [ ] Verify Node.js version

### No Deposits Detected

1. [ ] Check user addresses in database
2. [ ] Verify RPC connectivity
3. [ ] Check processing lag
4. [ ] Review filter logic in logs
5. [ ] Verify contract address correct

### High Error Rate

1. [ ] Check RPC endpoint status
2. [ ] Verify rate limits not exceeded
3. [ ] Check database connectivity
4. [ ] Review error patterns in logs
5. [ ] Consider switching RPC provider

### Processing Lag

1. [ ] Check RPC performance
2. [ ] Reduce batch size
3. [ ] Increase scan interval
4. [ ] Check server resources
5. [ ] Consider scaling horizontally

## Rollback Plan

If deployment fails:

1. [ ] Stop worker process
2. [ ] Restore previous version code
3. [ ] Restore database state (if needed):
   ```sql
   UPDATE worker_chain_state 
   SET last_processed_block = <previous_block>
   WHERE chain_id = (SELECT id FROM chains WHERE name = 'tron');
   ```
4. [ ] Restart worker
5. [ ] Verify operation
6. [ ] Document issues
7. [ ] Plan fixes for next deployment

## Success Criteria

Deployment is successful when:

- [ ] Worker running continuously for 24 hours
- [ ] Processing lag consistently < 5 minutes
- [ ] Real deposits detected and credited correctly
- [ ] No error rate spikes
- [ ] Memory usage stable
- [ ] CPU usage reasonable
- [ ] All monitoring alerts configured
- [ ] Team comfortable with operations

---

## Quick Reference

### Useful Commands

```bash
# Check worker status (PM2)
pm2 status

# View logs
pm2 logs coinsensei-tron-worker

# Restart worker
pm2 restart coinsensei-tron-worker

# Check TypeScript compilation
npm run build

# Verify setup
npm run verify

# Start worker
npm start
```

### Useful SQL Queries

```sql
-- Check worker state
SELECT * FROM worker_chain_state 
WHERE chain_id = (SELECT id FROM chains WHERE name = 'tron');

-- Check recent deposits
SELECT * FROM deposits 
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;

-- Check processing lag
SELECT 
  last_processed_block,
  EXTRACT(EPOCH FROM (NOW() - updated_at)) as seconds_since_update
FROM worker_chain_state
WHERE chain_id = (SELECT id FROM chains WHERE name = 'tron');

-- Check user balances
SELECT u.user_id, a.symbol, u.balance
FROM user_asset_balances u
JOIN assets a ON a.id = u.asset_id;
```

---

**Version:** 1.0  
**Last Updated:** December 20, 2025  
**Maintained By:** CoinSensei Engineering Team


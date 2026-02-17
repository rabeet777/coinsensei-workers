# Production Deployment Guide

This guide covers deploying the CoinSensei Workers to production environments.

## Deployment Options

### Option 1: PM2 (Recommended for Single Server)

#### Install PM2

```bash
npm install -g pm2
```

#### Create PM2 Ecosystem File

Create `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [{
    name: 'coinsensei-tron-worker',
    script: 'tsx',
    args: 'src/index.ts',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
  }]
};
```

#### Start with PM2

```bash
# Create logs directory
mkdir -p logs

# Start the worker
pm2 start ecosystem.config.js

# Save PM2 process list
pm2 save

# Setup PM2 to start on system boot
pm2 startup

# Monitor
pm2 monit

# View logs
pm2 logs coinsensei-tron-worker
```

#### PM2 Management Commands

```bash
# Restart worker
pm2 restart coinsensei-tron-worker

# Stop worker
pm2 stop coinsensei-tron-worker

# Delete worker from PM2
pm2 delete coinsensei-tron-worker

# View status
pm2 status

# View detailed info
pm2 info coinsensei-tron-worker
```

---

### Option 2: Systemd (Linux Systems)

#### Create Systemd Service File

Create `/etc/systemd/system/coinsensei-worker.service`:

```ini
[Unit]
Description=CoinSensei TRON Deposit Worker
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/coinsensei-workers
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=coinsensei-worker

# Environment variables
Environment="NODE_ENV=production"
Environment="LOG_LEVEL=info"
EnvironmentFile=/path/to/coinsensei-workers/.env

[Install]
WantedBy=multi-user.target
```

#### Enable and Start Service

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable coinsensei-worker

# Start service
sudo systemctl start coinsensei-worker

# Check status
sudo systemctl status coinsensei-worker

# View logs
sudo journalctl -u coinsensei-worker -f

# Restart service
sudo systemctl restart coinsensei-worker

# Stop service
sudo systemctl stop coinsensei-worker
```

---

### Option 3: Docker

#### Create Dockerfile

Create `Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

USER nodejs

# Start worker
CMD ["npx", "tsx", "src/index.ts"]
```

#### Create docker-compose.yml

```yaml
version: '3.8'

services:
  tron-worker:
    build: .
    container_name: coinsensei-tron-worker
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=info
    volumes:
      - ./logs:/app/logs
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

#### Build and Run

```bash
# Build image
docker build -t coinsensei-worker .

# Run with docker-compose
docker-compose up -d

# View logs
docker-compose logs -f tron-worker

# Restart
docker-compose restart tron-worker

# Stop
docker-compose down
```

---

### Option 4: Kubernetes

#### Create Kubernetes Deployment

Create `k8s/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coinsensei-tron-worker
  labels:
    app: coinsensei-worker
spec:
  replicas: 1
  selector:
    matchLabels:
      app: coinsensei-worker
  template:
    metadata:
      labels:
        app: coinsensei-worker
    spec:
      containers:
      - name: tron-worker
        image: your-registry/coinsensei-worker:latest
        env:
        - name: NODE_ENV
          value: "production"
        - name: LOG_LEVEL
          value: "info"
        - name: SUPABASE_URL
          valueFrom:
            secretKeyRef:
              name: coinsensei-secrets
              key: supabase-url
        - name: SUPABASE_SERVICE_ROLE_KEY
          valueFrom:
            secretKeyRef:
              name: coinsensei-secrets
              key: supabase-key
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - "pgrep -f 'tsx src/index.ts'"
          initialDelaySeconds: 30
          periodSeconds: 30
```

#### Create Secret

```bash
kubectl create secret generic coinsensei-secrets \
  --from-literal=supabase-url='your-url' \
  --from-literal=supabase-key='your-key'
```

#### Deploy

```bash
kubectl apply -f k8s/deployment.yaml

# Check status
kubectl get pods -l app=coinsensei-worker

# View logs
kubectl logs -l app=coinsensei-worker -f

# Scale
kubectl scale deployment coinsensei-tron-worker --replicas=2
```

---

## Environment Configuration

### Production Environment Variables

```bash
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...

# Recommended
NODE_ENV=production
LOG_LEVEL=info
BATCH_BLOCK_SIZE=100
SCAN_INTERVAL_MS=10000
```

### Environment Variable Best Practices

1. **Never commit `.env` to version control**
2. **Use secret management services**:
   - AWS Secrets Manager
   - HashiCorp Vault
   - Kubernetes Secrets
   - Docker Secrets

3. **Rotate credentials regularly**

---

## Monitoring & Alerts

### Health Checks

Monitor these metrics:

1. **Worker State**
   ```sql
   -- Check last processed block vs current
   SELECT 
     chain_id,
     last_processed_block,
     updated_at,
     EXTRACT(EPOCH FROM (NOW() - updated_at)) as seconds_since_update
   FROM worker_chain_state
   WHERE chain_id = (SELECT id FROM chains WHERE name = 'tron');
   ```

2. **Recent Deposits**
   ```sql
   -- Check deposits in last hour
   SELECT COUNT(*), SUM(amount_human::numeric)
   FROM deposits
   WHERE created_at > NOW() - INTERVAL '1 hour';
   ```

3. **Processing Lag**
   - Alert if `seconds_since_update > 300` (5 minutes)
   - Indicates worker is stuck or crashed

### Log Aggregation

#### Using Datadog

```javascript
// Add to src/utils/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  // Datadog expects these fields
  mixin() {
    return {
      service: 'coinsensei-worker',
      env: process.env.NODE_ENV,
    };
  },
});
```

#### Using CloudWatch (AWS)

Install cloudwatch transport:
```bash
npm install pino-cloudwatch
```

Update logger:
```javascript
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-cloudwatch',
    options: {
      logGroupName: '/coinsensei/workers',
      logStreamName: 'tron-deposit-worker',
      awsRegion: 'us-east-1',
    },
  },
});
```

---

## Performance Tuning

### Batch Size Optimization

```bash
# Faster scanning (more RPC calls)
BATCH_BLOCK_SIZE=50

# Slower but fewer RPC calls
BATCH_BLOCK_SIZE=200
```

### Scan Interval

```bash
# More frequent checks (higher load)
SCAN_INTERVAL_MS=5000

# Less frequent (lower load, higher latency)
SCAN_INTERVAL_MS=30000
```

### Database Connection Pooling

Supabase client handles connection pooling automatically. For high-throughput scenarios:

1. Use connection pooler in Supabase (Transaction mode)
2. Increase Supabase plan for more connections
3. Consider read replicas for queries

---

## Scaling Strategies

### Vertical Scaling (Single Instance)

- Increase server resources (CPU, RAM)
- Optimize batch sizes
- Use faster RPC endpoints

### Horizontal Scaling (Multiple Instances)

**Safe to run multiple instances** - idempotency guarantees no duplicates!

```bash
# PM2 cluster mode
pm2 start ecosystem.config.js -i 3

# Docker Compose
docker-compose up -d --scale tron-worker=3

# Kubernetes
kubectl scale deployment coinsensei-tron-worker --replicas=3
```

**How it works:**
- Each instance scans independently
- Database unique constraint prevents duplicate deposits
- First instance to insert wins, others skip gracefully

### Sharding by Asset

For many assets, create separate workers per asset:

```javascript
// worker-usdt.ts
const worker = new TronDepositWorker();
await worker.initialize(['USDT']);

// worker-usdc.ts  
const worker = new TronDepositWorker();
await worker.initialize(['USDC']);
```

---

## Backup & Recovery

### Database Backups

1. **Supabase automated backups** (included in plan)
2. **Manual backup**:
   ```bash
   pg_dump $DATABASE_URL > backup-$(date +%Y%m%d).sql
   ```

### State Recovery

If worker state is corrupted:

```sql
-- Reset to specific block
UPDATE worker_chain_state 
SET last_processed_block = 12345678
WHERE chain_id = (SELECT id FROM chains WHERE name = 'tron');
```

### Disaster Recovery

1. Worker crashes → automatically restarts from last processed block
2. Database corruption → restore from backup, may reprocess some deposits (idempotency ensures no duplicates)
3. Lost deposits → reset `last_processed_block` and rescan

---

## Security Checklist

- [ ] Service role key stored securely (not in code)
- [ ] Firewall rules limit database access
- [ ] Worker runs with minimal permissions
- [ ] Logs don't contain sensitive data
- [ ] RPC endpoints use HTTPS
- [ ] Regular security updates applied
- [ ] Monitoring and alerting configured
- [ ] Incident response plan documented

---

## Troubleshooting Production Issues

### Worker Not Processing Blocks

1. Check if worker is running: `pm2 status` or `systemctl status`
2. Check logs for errors
3. Verify database connectivity
4. Check RPC endpoint availability
5. Verify worker_chain_state is updating

### High RPC Error Rate

1. Switch to paid RPC provider
2. Increase retry backoff
3. Reduce batch size
4. Add rate limiting

### Memory Leaks

1. Monitor with `pm2 monit`
2. Set `max_memory_restart` in PM2
3. Check for unhandled promise rejections
4. Profile with Node.js profiler

### Duplicate Deposits (Should Never Happen)

1. Check database unique constraints exist
2. Verify idempotency logic
3. Check logs for race conditions
4. Report as critical bug

---

## Maintenance

### Regular Tasks

- **Daily**: Check logs for errors
- **Weekly**: Review processing lag metrics
- **Monthly**: Update dependencies, review performance
- **Quarterly**: Security audit, backup testing

### Updates

```bash
# Update dependencies
npm update

# Update specific package
npm install tronweb@latest

# Rebuild
npm run build

# Restart
pm2 restart coinsensei-tron-worker
```

---

## Support & Escalation

For production issues:

1. Check logs first
2. Review monitoring dashboards
3. Verify database state
4. Check external dependencies (RPC, Supabase)
5. Escalate to engineering team with logs and context


/**
 * PM2 ecosystem config for coinsensei-workers.
 * Run with: pm2 start ecosystem.config.cjs
 * Ensure .env has SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
module.exports = {
  apps: [
    {
      name: 'withdrawal-risk-engine',
      script: 'node',
      args: '--import tsx src/index-withdrawal-risk-engine.ts',
      interpreter: 'none',
      env: { NODE_ENV: 'production' },
      env_file: '.env',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
    },
    // Add other workers as needed, e.g.:
    // { name: 'withdrawal-enqueue', script: 'node', args: '--import tsx src/index-withdrawal-enqueue.ts', ... },
  ],
};

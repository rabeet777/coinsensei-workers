import 'dotenv/config';
import { WithdrawalRiskEngineWorker } from './workers/withdrawal-risk-engine/withdrawal-risk-engine.worker.js';
import { logger } from './utils/logger.js';

logger.info('🚀 Starting Withdrawal Risk Engine Worker...');

const worker = new WithdrawalRiskEngineWorker();

async function startWorker() {
  try {
    await worker.initialize();
    worker.start();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, 'Failed to start Withdrawal Risk Engine Worker');
    process.exit(1);
  }
}

async function handleShutdown() {
  logger.info('Shutting down Withdrawal Risk Engine Worker...');
  await worker.shutdown();
  process.exit(0);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

startWorker();

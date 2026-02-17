import 'dotenv/config';
import { TronWithdrawalWorker } from './workers/withdrawal/tron-withdrawal.worker.js';
import { logger } from './utils/logger.js';

logger.info('🚀 Starting TRON Withdrawal Worker...');

const worker = new TronWithdrawalWorker();

async function startWorker() {
  try {
    await worker.initialize();
    worker.start();
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to start TRON Withdrawal Worker');
    process.exit(1);
  }
}

async function handleShutdown() {
  logger.info('Shutting down TRON Withdrawal Worker...');
  await worker.shutdown();
  process.exit(0);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

startWorker();


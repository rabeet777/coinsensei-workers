import 'dotenv/config';
import { WithdrawalEnqueueWorker } from './workers/withdrawal-enqueue/withdrawal-enqueue.worker.js';
import { logger } from './utils/logger.js';

logger.info('🚀 Starting Withdrawal Enqueue Worker...');

const worker = new WithdrawalEnqueueWorker();

async function startWorker() {
  try {
    await worker.initialize();
    worker.start();
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to start Withdrawal Enqueue Worker');
    process.exit(1);
  }
}

async function handleShutdown() {
  logger.info('Shutting down Withdrawal Enqueue Worker...');
  await worker.shutdown();
  process.exit(0);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

startWorker();


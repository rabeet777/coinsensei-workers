import 'dotenv/config';
import { ConsolidationConfirmationWorker } from './workers/consolidation-confirmation/consolidation-confirmation.worker.js';
import { logger } from './utils/logger.js';

logger.info('🚀 Starting Consolidation Confirmation Worker...');

const worker = new ConsolidationConfirmationWorker();

async function startWorker() {
  try {
    await worker.initialize();
    worker.start();
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to start Consolidation Confirmation Worker');
    process.exit(1);
  }
}

async function handleShutdown() {
  logger.info('Shutting down Consolidation Confirmation Worker...');
  await worker.shutdown();
  process.exit(0);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

startWorker();


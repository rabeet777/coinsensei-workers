import 'dotenv/config';
import { TronConsolidationWorker } from './workers/consolidation/tron-consolidation.worker.js';
import { logger } from './utils/logger.js';

logger.info('🚀 Starting TRON Consolidation Worker...');

const worker = new TronConsolidationWorker();

async function startWorker() {
  try {
    await worker.initialize();
    await worker.start();
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to start TRON Consolidation Worker');
    process.exit(1);
  }
}

async function handleShutdown() {
  logger.info('Shutting down TRON Consolidation Worker...');
  await worker.shutdown();
  process.exit(0);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

startWorker();


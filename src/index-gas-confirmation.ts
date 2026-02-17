import 'dotenv/config';
import { GasConfirmationWorker } from './workers/gas-confirmation/gas-confirmation.worker.js';
import { logger } from './utils/logger.js';

async function main() {
  logger.info('🚀 Starting Gas Confirmation Worker...');

  const worker = new GasConfirmationWorker();

  try {
    await worker.initialize();

    // Graceful shutdown: update worker_status to stopped before exit (register before start so handlers are active)
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully...');
      await worker.shutdown();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down gracefully...');
      await worker.shutdown();
      process.exit(0);
    });

    await worker.start();
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to start Gas Confirmation Worker');
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error({ error: error.message }, 'Unhandled error in main');
  process.exit(1);
});


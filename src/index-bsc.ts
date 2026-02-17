import { BscDepositWorker } from './workers/deposit/bsc.deposit.worker.js';
import { logger } from './utils/logger.js';

/**
 * Entry point for BSC Deposit Worker
 */
async function main() {
  logger.info('🚀 Starting BSC Deposit Worker...');

  // Create and initialize BSC deposit worker
  const bscWorker = new BscDepositWorker();

  try {
    // Initialize worker (load config, assets, addresses)
    await bscWorker.initialize();

    // Graceful shutdown: update worker_status to stopped before exit
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await bscWorker.shutdown();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await bscWorker.shutdown();
      process.exit(0);
    });

    // Start the worker loop
    await bscWorker.start();
  } catch (error: any) {
    logger.error(
      { error: error.message, stack: error.stack },
      'Fatal error in BSC worker'
    );
    process.exit(1);
  }
}

// Run the main function
main().catch((error) => {
  logger.error(
    { error: error.message, stack: error.stack },
    'Unhandled error in main'
  );
  process.exit(1);
});


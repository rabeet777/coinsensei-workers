import { TronDepositWorker } from './workers/deposit/tron.deposit.worker.js';
import { logger } from './utils/logger.js';

/**
 * Main entry point for CoinSensei Workers
 */
async function main() {
  logger.info('🚀 Starting CoinSensei Workers...');

  // Create and initialize TRON deposit worker
  const tronWorker = new TronDepositWorker();

  try {
    // Initialize worker (load config, assets, addresses)
    await tronWorker.initialize();

    // Graceful shutdown: update worker_status to stopped before exit
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await tronWorker.shutdown();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await tronWorker.shutdown();
      process.exit(0);
    });

    // Start the worker loop
    await tronWorker.start();
  } catch (error: any) {
    logger.error(
      { error: error.message, stack: error.stack },
      'Fatal error in main process'
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


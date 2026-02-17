import { ConfirmationWorker } from './workers/confirmation/confirmation.worker.js';
import { logger } from './utils/logger.js';

/**
 * Entry point for Confirmation Worker
 */
async function main() {
  logger.info('🚀 Starting Confirmation Worker...');

  // Create and initialize confirmation worker
  const confirmationWorker = new ConfirmationWorker();

  try {
    // Initialize worker (load chains and clients)
    await confirmationWorker.initialize();

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await confirmationWorker.shutdown();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await confirmationWorker.shutdown();
      process.exit(0);
    });

    // Start the worker loop
    await confirmationWorker.start();
  } catch (error: any) {
    logger.error(
      { error: error.message, stack: error.stack },
      'Fatal error in confirmation worker'
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


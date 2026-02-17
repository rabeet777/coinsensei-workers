import { BalanceSyncWorker } from './workers/balance-sync/balance-sync.worker.js';
import { logger } from './utils/logger.js';

/**
 * Entry point for Balance Sync Worker
 */
async function main() {
  logger.info('🚀 Starting Balance Sync Worker...');

  // Create and initialize balance sync worker
  const balanceSyncWorker = new BalanceSyncWorker();

  try {
    // Initialize worker (load chains and clients)
    await balanceSyncWorker.initialize();

    // Graceful shutdown: update worker_status to stopped before exit
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await balanceSyncWorker.shutdown();
      await balanceSyncWorker.releaseAllLocks();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await balanceSyncWorker.shutdown();
      await balanceSyncWorker.releaseAllLocks();
      process.exit(0);
    });

    await balanceSyncWorker.start();
    await balanceSyncWorker.releaseAllLocks();
    process.exit(0);
  } catch (error: any) {
    logger.error(
      { error: error.message, stack: error.stack },
      'Fatal error in balance sync worker'
    );
    await balanceSyncWorker.releaseAllLocks();
    process.exit(1);
  }
}

// Run the main function
main().catch(async (error) => {
  logger.error(
    { error: error.message, stack: error.stack },
    'Unhandled error in main'
  );
  process.exit(1);
});


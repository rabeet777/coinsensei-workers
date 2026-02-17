import { BscGasTopupWorker } from './workers/gas-topup/bsc-gas-topup.worker.js';
import { logger } from './utils/logger.js';

/**
 * Entry point for BSC Gas Top-Up Worker
 */
async function main() {
  logger.info('🚀 Starting BSC Gas Top-Up Worker...');

  const worker = new BscGasTopupWorker();

  try {
    await worker.initialize();

    // Graceful shutdown: update worker_status to stopped before exit
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down...');
      await worker.shutdown();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down...');
      await worker.shutdown();
      process.exit(0);
    });

    await worker.start();
  } catch (error: any) {
    logger.error(
      { error: error.message, stack: error.stack },
      'Fatal error in BSC gas top-up worker'
    );
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error({ error: error.message }, 'Unhandled error');
  process.exit(1);
});


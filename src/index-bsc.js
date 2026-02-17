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
        // Handle graceful shutdown
        process.on('SIGINT', () => {
            logger.info('Received SIGINT, shutting down gracefully...');
            bscWorker.stop();
            process.exit(0);
        });
        process.on('SIGTERM', () => {
            logger.info('Received SIGTERM, shutting down gracefully...');
            bscWorker.stop();
            process.exit(0);
        });
        // Start the worker loop
        await bscWorker.start();
    }
    catch (error) {
        logger.error({ error: error.message, stack: error.stack }, 'Fatal error in BSC worker');
        process.exit(1);
    }
}
// Run the main function
main().catch((error) => {
    logger.error({ error: error.message, stack: error.stack }, 'Unhandled error in main');
    process.exit(1);
});
//# sourceMappingURL=index-bsc.js.map
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
        // Handle graceful shutdown: stop() so loop exits and control plane setStopped() runs
        process.on('SIGINT', () => {
            logger.info('Received SIGINT, shutting down gracefully...');
            balanceSyncWorker.stop();
        });
        process.on('SIGTERM', () => {
            logger.info('Received SIGTERM, shutting down gracefully...');
            balanceSyncWorker.stop();
        });
        // Start the worker loop (returns when stop() was called and loop exited; setStopped() runs there)
        await balanceSyncWorker.start();
        await balanceSyncWorker.releaseAllLocks();
        process.exit(0);
    }
    catch (error) {
        logger.error({ error: error.message, stack: error.stack }, 'Fatal error in balance sync worker');
        await balanceSyncWorker.releaseAllLocks();
        process.exit(1);
    }
}
// Run the main function
main().catch(async (error) => {
    logger.error({ error: error.message, stack: error.stack }, 'Unhandled error in main');
    process.exit(1);
});
//# sourceMappingURL=index-balance-sync.js.map
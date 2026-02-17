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
        process.on('SIGINT', () => {
            logger.info('Received SIGINT, shutting down gracefully...');
            confirmationWorker.stop();
            process.exit(0);
        });
        process.on('SIGTERM', () => {
            logger.info('Received SIGTERM, shutting down gracefully...');
            confirmationWorker.stop();
            process.exit(0);
        });
        // Start the worker loop
        await confirmationWorker.start();
    }
    catch (error) {
        logger.error({ error: error.message, stack: error.stack }, 'Fatal error in confirmation worker');
        process.exit(1);
    }
}
// Run the main function
main().catch((error) => {
    logger.error({ error: error.message, stack: error.stack }, 'Unhandled error in main');
    process.exit(1);
});
//# sourceMappingURL=index-confirmation.js.map
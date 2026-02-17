import 'dotenv/config';
import { GasConfirmationWorker } from './workers/gas-confirmation/gas-confirmation.worker.js';
import { logger } from './utils/logger.js';
async function main() {
    logger.info('🚀 Starting Gas Confirmation Worker...');
    const worker = new GasConfirmationWorker();
    try {
        await worker.initialize();
        await worker.start();
    }
    catch (error) {
        logger.error({ error: error.message }, 'Failed to start Gas Confirmation Worker');
        process.exit(1);
    }
    // Graceful shutdown
    process.on('SIGTERM', () => {
        logger.info('SIGTERM received, shutting down gracefully...');
        worker.stop();
        process.exit(0);
    });
    process.on('SIGINT', () => {
        logger.info('SIGINT received, shutting down gracefully...');
        worker.stop();
        process.exit(0);
    });
}
main().catch((error) => {
    logger.error({ error: error.message }, 'Unhandled error in main');
    process.exit(1);
});
//# sourceMappingURL=index-gas-confirmation.js.map
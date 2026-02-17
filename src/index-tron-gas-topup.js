import { TronGasTopupWorker } from './workers/gas-topup/tron-gas-topup.worker.js';
import { logger } from './utils/logger.js';
/**
 * Entry point for TRON Gas Top-Up Worker
 */
async function main() {
    logger.info('🚀 Starting TRON Gas Top-Up Worker...');
    const worker = new TronGasTopupWorker();
    try {
        await worker.initialize();
        // Graceful shutdown: stop() so loop exits and control plane setStopped() runs
        process.on('SIGINT', () => {
            logger.info('Received SIGINT, shutting down...');
            worker.stop();
        });
        process.on('SIGTERM', () => {
            logger.info('Received SIGTERM, shutting down...');
            worker.stop();
        });
        await worker.start();
        process.exit(0);
    }
    catch (error) {
        logger.error({ error: error.message, stack: error.stack }, 'Fatal error in TRON gas top-up worker');
        process.exit(1);
    }
}
main().catch((error) => {
    logger.error({ error: error.message }, 'Unhandled error');
    process.exit(1);
});
//# sourceMappingURL=index-tron-gas-topup.js.map
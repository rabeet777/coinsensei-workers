import 'dotenv/config';
import { WithdrawalConfirmationWorker } from './workers/withdrawal-confirmation/withdrawal-confirmation.worker.js';
import { logger } from './utils/logger.js';
logger.info('🚀 Starting Withdrawal Confirmation Worker...');
const worker = new WithdrawalConfirmationWorker();
async function startWorker() {
    try {
        await worker.initialize();
        worker.start();
    }
    catch (error) {
        logger.error({ error: error.message }, 'Failed to start Withdrawal Confirmation Worker');
        process.exit(1);
    }
}
function handleShutdown() {
    logger.info('Shutting down Withdrawal Confirmation Worker...');
    worker.stop();
    process.exit(0);
}
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
startWorker();
//# sourceMappingURL=index-withdrawal-confirmation.js.map
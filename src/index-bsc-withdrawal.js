import 'dotenv/config';
import { BscWithdrawalWorker } from './workers/withdrawal/bsc-withdrawal.worker.js';
import { logger } from './utils/logger.js';
logger.info('🚀 Starting BSC Withdrawal Worker...');
const worker = new BscWithdrawalWorker();
async function startWorker() {
    try {
        await worker.initialize();
        worker.start();
    }
    catch (error) {
        logger.error({ error: error.message }, 'Failed to start BSC Withdrawal Worker');
        process.exit(1);
    }
}
function handleShutdown() {
    logger.info('Shutting down BSC Withdrawal Worker...');
    worker.stop();
    process.exit(0);
}
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
startWorker();
//# sourceMappingURL=index-bsc-withdrawal.js.map
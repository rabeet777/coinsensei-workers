import 'dotenv/config';
import { BscConsolidationWorker } from './workers/consolidation/bsc-consolidation.worker.js';
import { logger } from './utils/logger.js';
logger.info('🚀 Starting BSC Consolidation Worker...');
const worker = new BscConsolidationWorker();
async function startWorker() {
    try {
        await worker.initialize();
        await worker.start();
    }
    catch (error) {
        logger.error({ error: error.message }, 'Failed to start BSC Consolidation Worker');
        process.exit(1);
    }
}
function handleShutdown() {
    logger.info('Shutting down BSC Consolidation Worker...');
    worker.stop();
    process.exit(0);
}
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
startWorker();
//# sourceMappingURL=index-bsc-consolidation.js.map
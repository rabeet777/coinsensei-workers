import { RuleExecutionWorker } from './workers/rule-execution/rule-execution.worker.js';
import { logger } from './utils/logger.js';

/**
 * Entry point for Rule Execution Worker
 */
async function main() {
  logger.info('🚀 Starting Rule Execution Worker...');

  // Create and initialize rule execution worker
  const ruleExecutionWorker = new RuleExecutionWorker();

  try {
    // Initialize worker
    await ruleExecutionWorker.initialize();

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await ruleExecutionWorker.shutdown();
      await ruleExecutionWorker.releaseAllLocks();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await ruleExecutionWorker.shutdown();
      await ruleExecutionWorker.releaseAllLocks();
      process.exit(0);
    });

    // Start the worker loop
    await ruleExecutionWorker.start();
  } catch (error: any) {
    logger.error(
      { error: error.message, stack: error.stack },
      'Fatal error in rule execution worker'
    );
    await ruleExecutionWorker.releaseAllLocks();
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


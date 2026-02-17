import * as dotenv from 'dotenv';

dotenv.config();

interface EnvConfig {
  supabase: {
    url: string;
    serviceRoleKey: string;
  };
  worker: {
    scanIntervalMs: number;
    batchBlockSize: number;
  };
  nodeEnv: string;
  logLevel: string;
}

function validateEnv(): EnvConfig {
  const required = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  const missing = Object.entries(required)
    .filter(([_, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }

  return {
    supabase: {
      url: required.SUPABASE_URL!,
      serviceRoleKey: required.SUPABASE_SERVICE_ROLE_KEY!,
    },
    worker: {
      scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '10000', 10),
      batchBlockSize: parseInt(process.env.BATCH_BLOCK_SIZE || '100', 10),
    },
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}

export const env = validateEnv();


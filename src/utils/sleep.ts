/**
 * Sleep for a specified number of milliseconds
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep with exponential backoff for retries
 */
export async function sleepWithBackoff(
  attempt: number,
  baseMs: number = 1000,
  maxMs: number = 30000
): Promise<void> {
  const backoffMs = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  await sleep(backoffMs);
}


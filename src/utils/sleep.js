/**
 * Sleep for a specified number of milliseconds
 */
export async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Sleep with exponential backoff for retries
 */
export async function sleepWithBackoff(attempt, baseMs = 1000, maxMs = 30000) {
    const backoffMs = Math.min(baseMs * Math.pow(2, attempt), maxMs);
    await sleep(backoffMs);
}
//# sourceMappingURL=sleep.js.map
/**
 * Sleep for a specified number of milliseconds
 */
export declare function sleep(ms: number): Promise<void>;
/**
 * Sleep with exponential backoff for retries
 */
export declare function sleepWithBackoff(attempt: number, baseMs?: number, maxMs?: number): Promise<void>;
//# sourceMappingURL=sleep.d.ts.map
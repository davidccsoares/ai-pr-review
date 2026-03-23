/**
 * Thin wrapper around global fetch that adds a default timeout.
 * Keeps the same signature so callers only need to change the import.
 *
 * @param {string|Request} input
 * @param {RequestInit & { timeout?: number }} [init]
 * @returns {Promise<Response>}
 */
export function fetchWithTimeout(input, init = {}) {
  const { timeout = 10_000, ...rest } = init;
  // Don't override an existing signal the caller already set
  if (!rest.signal) {
    rest.signal = AbortSignal.timeout(timeout);
  }
  return fetch(input, rest);
}

/**
 * Fetch with automatic retry + exponential backoff for transient failures.
 * Retries on 429 (rate limit) and 5xx (server errors).
 * Non-retryable failures (4xx except 429) are returned immediately.
 *
 * @param {string|Request} input
 * @param {RequestInit & { timeout?: number, retries?: number, tag?: string }} [init]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(input, init = {}) {
  const { retries = 3, tag = "", ...fetchInit } = init;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(input, fetchInit);

      // Success or non-retryable client error → return immediately
      if (res.ok || (res.status < 500 && res.status !== 429)) {
        return res;
      }

      // Retryable: 429 or 5xx
      if (attempt < retries) {
        const delay = Math.min(1000 * 2 ** attempt, 8000); // 1s, 2s, 4s, max 8s
        console.log(`(log) [${tag}] Retry ${attempt + 1}/${retries} after ${res.status} (wait ${delay}ms)`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // Final attempt failed — return the last response
      return res;
    } catch (err) {
      // Network/timeout errors are retryable
      if (attempt < retries) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        console.log(`(log) [${tag}] Retry ${attempt + 1}/${retries} after error: ${err.message} (wait ${delay}ms)`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err; // Final attempt — let the caller handle it
    }
  }
}

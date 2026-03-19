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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWithRetry } from '../src/lib/fetch.js';

// ─── fetchWithRetry ──────────────────────────────────────────────────────────

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Suppress retry log noise in test output
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('returns immediately on success (200)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 })
    );

    const res = await fetchWithRetry('https://example.com', { retries: 3 });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns immediately on non-retryable 4xx (e.g. 404)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 })
    );

    const res = await fetchWithRetry('https://example.com', { retries: 3 });
    expect(res.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns immediately on 401 (no retry)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('unauthorized', { status: 401 })
    );

    const res = await fetchWithRetry('https://example.com', { retries: 3 });
    expect(res.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds on retry', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await fetchWithRetry('https://example.com', { retries: 3, timeout: 5000 });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 and succeeds on retry', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('server error', { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await fetchWithRetry('https://example.com', { retries: 3, timeout: 5000 });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 503 and succeeds on retry', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await fetchWithRetry('https://example.com', { retries: 3, timeout: 5000 });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns last failure after exhausting retries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('still broken', { status: 500 })
    );

    const res = await fetchWithRetry('https://example.com', { retries: 2, timeout: 5000 });
    expect(res.status).toBe(500);
    // 1 initial + 2 retries = 3 calls
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries on network errors and succeeds on retry', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await fetchWithRetry('https://example.com', { retries: 3, timeout: 5000 });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws network error after exhausting retries', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network timeout'));

    await expect(
      fetchWithRetry('https://example.com', { retries: 1, timeout: 5000 })
    ).rejects.toThrow('network timeout');
    // 1 initial + 1 retry = 2 calls
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('defaults to 3 retries when not specified', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('error', { status: 500 })
    );

    await fetchWithRetry('https://example.com', { timeout: 5000 });
    // 1 initial + 3 retries = 4 calls
    expect(fetch).toHaveBeenCalledTimes(4);
  }, 15000);

  it('passes tag through for logging', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await fetchWithRetry('https://example.com', { retries: 2, tag: 'TestTag', timeout: 5000 });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[TestTag]')
    );
  });

  it('works with zero retries (single attempt)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('error', { status: 500 })
    );

    const res = await fetchWithRetry('https://example.com', { retries: 0, timeout: 5000 });
    expect(res.status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

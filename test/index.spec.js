import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

describe('AI PR Review worker', () => {
	it('rejects non-POST requests (unit style)', async () => {
		const request = new Request('http://example.com', { method: 'GET' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
		expect(await response.text()).toBe('Only POST allowed');
	});

	it('returns 200 for POST with no PR payload (unit style)', async () => {
		const request = new Request('http://example.com', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ resource: {} }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('No PR');
	});

	it('rejects non-POST requests (integration style)', async () => {
		const response = await SELF.fetch('http://example.com');
		expect(response.status).toBe(405);
	});
});

import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';

describe('AI PR Review gateway worker', () => {
	it('returns health JSON on GET requests', async () => {
		const request = new Request('http://example.com', { method: 'GET' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.status).toBe('ok');
		expect(body.worker).toBe('ai-pr-review-gateway');
		expect(body.uptime).toBeTypeOf('number');
	});

	it('rejects PUT requests with 405', async () => {
		const request = new Request('http://example.com', { method: 'PUT' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
		expect(await response.text()).toBe('Only GET and POST allowed');
	});

	it('rejects DELETE requests with 405', async () => {
		const request = new Request('http://example.com', { method: 'DELETE' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
		expect(await response.text()).toBe('Only GET and POST allowed');
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

	it('returns 400 for invalid JSON body', async () => {
		const request = new Request('http://example.com', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not json',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it('returns 202 for valid PR webhook payload', async () => {
		const request = new Request('http://example.com', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				resource: {
					pullRequestId: 123,
					repository: {
						id: 'repo-id',
						project: { name: 'MyProject' },
					},
					lastMergeSourceCommit: { commitId: 'abc123' },
					lastMergeTargetCommit: { commitId: 'def456' },
				},
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Don't waitOnExecutionContext here — the background work will fail
		// (no real Azure/OpenRouter), but the immediate response should be 202.
		expect(response.status).toBe(202);
		expect(await response.text()).toBe('Accepted');
	});

	it('returns health JSON via integration-style GET', async () => {
		const response = await SELF.fetch('http://example.com');
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.status).toBe('ok');
	});
});

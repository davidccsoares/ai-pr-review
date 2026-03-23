import { describe, it, expect } from 'vitest';
import {
  detectFlakiness,
  upsertFlakyTest,
  updateRunsIndex,
  truncate,
  esc,
  shortenTestName,
  formatDate,
} from '../src/flaky-detective-worker.js';

// ─── Mock KV Store ──────────────────────────────────────────────────────────

function createMockKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, opts) {
      store.set(key, value);
    },
    async list({ prefix, cursor, limit }) {
      const keys = [];
      for (const [name] of store) {
        if (name.startsWith(prefix)) {
          keys.push({ name });
        }
      }
      return { keys, list_complete: true, cursor: null };
    },
  };
}

// ─── detectFlakiness ────────────────────────────────────────────────────────

describe('detectFlakiness', () => {
  it('returns empty for no results', () => {
    const { flakyTests, stats } = detectFlakiness([]);
    expect(flakyTests).toEqual([]);
    expect(stats.total).toBe(0);
    expect(stats.passed).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.duration).toBe(0);
  });

  it('detects a flaky test (Failed + Passed with same automatedTestName)', () => {
    const results = [
      { automatedTestName: 'test.A', outcome: 'Failed', durationInMs: 100, errorMessage: 'timeout' },
      { automatedTestName: 'test.A', outcome: 'Passed', durationInMs: 200 },
    ];
    const { flakyTests, stats } = detectFlakiness(results);

    expect(flakyTests.length).toBe(1);
    expect(flakyTests[0].testName).toBe('test.A');
    expect(flakyTests[0].errorMessage).toBe('timeout');
    expect(stats.total).toBe(1);
    expect(stats.passed).toBe(1); // flaky counts as passed
    expect(stats.failed).toBe(0);
    expect(stats.duration).toBe(300);
  });

  it('identifies consistently passing tests (not flaky)', () => {
    const results = [
      { automatedTestName: 'test.B', outcome: 'Passed', durationInMs: 50 },
    ];
    const { flakyTests, stats } = detectFlakiness(results);

    expect(flakyTests.length).toBe(0);
    expect(stats.passed).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('identifies consistently failing tests (not flaky)', () => {
    const results = [
      { automatedTestName: 'test.C', outcome: 'Failed', durationInMs: 50, errorMessage: 'error' },
      { automatedTestName: 'test.C', outcome: 'Failed', durationInMs: 60, errorMessage: 'error again' },
    ];
    const { flakyTests, stats } = detectFlakiness(results);

    expect(flakyTests.length).toBe(0);
    expect(stats.passed).toBe(0);
    expect(stats.failed).toBe(1);
  });

  it('handles multiple test names correctly', () => {
    const results = [
      // Test A: flaky (fail then pass)
      { automatedTestName: 'test.A', outcome: 'Failed', durationInMs: 100, errorMessage: 'timeout' },
      { automatedTestName: 'test.A', outcome: 'Passed', durationInMs: 200 },
      // Test B: pass
      { automatedTestName: 'test.B', outcome: 'Passed', durationInMs: 50 },
      // Test C: fail
      { automatedTestName: 'test.C', outcome: 'Failed', durationInMs: 75, errorMessage: 'broken' },
      // Test D: flaky (multiple fails then pass)
      { automatedTestName: 'test.D', outcome: 'Failed', durationInMs: 100, errorMessage: 'flake1' },
      { automatedTestName: 'test.D', outcome: 'Failed', durationInMs: 100, errorMessage: 'flake2' },
      { automatedTestName: 'test.D', outcome: 'Passed', durationInMs: 150 },
    ];

    const { flakyTests, stats } = detectFlakiness(results);

    expect(flakyTests.length).toBe(2);
    expect(flakyTests.map(f => f.testName).sort()).toEqual(['test.A', 'test.D']);
    expect(stats.total).toBe(4);
    expect(stats.passed).toBe(3); // A (flaky->passed), B, D (flaky->passed)
    expect(stats.failed).toBe(1); // C
  });

  it('falls back to testCaseTitle when automatedTestName is missing', () => {
    const results = [
      { testCaseTitle: 'My Test', outcome: 'Failed', durationInMs: 100, errorMessage: 'err' },
      { testCaseTitle: 'My Test', outcome: 'Passed', durationInMs: 200 },
    ];
    const { flakyTests } = detectFlakiness(results);
    expect(flakyTests[0].testName).toBe('My Test');
  });

  it('counts NotExecuted tests in total but not in passed/failed', () => {
    const results = [
      { automatedTestName: 'test.X', outcome: 'NotExecuted', durationInMs: 0 },
    ];
    const { flakyTests, stats } = detectFlakiness(results);

    expect(flakyTests.length).toBe(0);
    expect(stats.total).toBe(1);
    expect(stats.passed).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it('captures error message from the first failed attempt', () => {
    const results = [
      { automatedTestName: 'test.E', outcome: 'Failed', durationInMs: 100, errorMessage: 'first error', stackTrace: 'stack1' },
      { automatedTestName: 'test.E', outcome: 'Failed', durationInMs: 100, errorMessage: 'second error', stackTrace: 'stack2' },
      { automatedTestName: 'test.E', outcome: 'Passed', durationInMs: 200 },
    ];
    const { flakyTests } = detectFlakiness(results);
    expect(flakyTests[0].errorMessage).toBe('first error');
    expect(flakyTests[0].stackTrace).toBe('stack1');
  });

  it('handles missing durationInMs gracefully', () => {
    const results = [
      { automatedTestName: 'test.F', outcome: 'Passed' },
    ];
    const { stats } = detectFlakiness(results);
    expect(stats.duration).toBe(0);
  });
});

// ─── upsertFlakyTest ────────────────────────────────────────────────────────

describe('upsertFlakyTest', () => {
  it('creates a new entry when test is seen for the first time', async () => {
    const kv = createMockKV();
    const env = { BOT_KV: kv };

    await upsertFlakyTest(env, { testName: 'test.A', errorMessage: 'timeout' }, '1001', '2026-03-23T10:00:00Z');

    const raw = await kv.get('flaky:test.A');
    const data = JSON.parse(raw);

    expect(data.totalFlakes).toBe(1);
    expect(data.firstSeen).toBe('2026-03-23T10:00:00Z');
    expect(data.lastSeen).toBe('2026-03-23T10:00:00Z');
    expect(data.occurrences.length).toBe(1);
    expect(data.occurrences[0].buildId).toBe('1001');
  });

  it('appends a new occurrence for repeat flaky test', async () => {
    const kv = createMockKV();
    const env = { BOT_KV: kv };

    // First occurrence
    await upsertFlakyTest(env, { testName: 'test.A', errorMessage: 'timeout' }, '1001', '2026-03-22T10:00:00Z');
    // Second occurrence
    await upsertFlakyTest(env, { testName: 'test.A', errorMessage: 'timeout again' }, '1002', '2026-03-23T10:00:00Z');

    const raw = await kv.get('flaky:test.A');
    const data = JSON.parse(raw);

    expect(data.totalFlakes).toBe(2);
    expect(data.occurrences.length).toBe(2);
    expect(data.firstSeen).toBe('2026-03-22T10:00:00Z');
    expect(data.lastSeen).toBe('2026-03-23T10:00:00Z');
  });

  it('is idempotent — same buildId is not duplicated', async () => {
    const kv = createMockKV();
    const env = { BOT_KV: kv };

    await upsertFlakyTest(env, { testName: 'test.A', errorMessage: 'timeout' }, '1001', '2026-03-23T10:00:00Z');
    await upsertFlakyTest(env, { testName: 'test.A', errorMessage: 'timeout' }, '1001', '2026-03-23T10:00:00Z');

    const raw = await kv.get('flaky:test.A');
    const data = JSON.parse(raw);

    expect(data.totalFlakes).toBe(1);
    expect(data.occurrences.length).toBe(1);
  });

  it('truncates long error messages', async () => {
    const kv = createMockKV();
    const env = { BOT_KV: kv };
    const longError = 'x'.repeat(1000);

    await upsertFlakyTest(env, { testName: 'test.A', errorMessage: longError }, '1001', '2026-03-23T10:00:00Z');

    const raw = await kv.get('flaky:test.A');
    const data = JSON.parse(raw);

    expect(data.occurrences[0].errorMessage.length).toBeLessThanOrEqual(501); // 500 + "…"
  });
});

// ─── updateRunsIndex ────────────────────────────────────────────────────────

describe('updateRunsIndex', () => {
  it('creates a new index with the first build', async () => {
    const kv = createMockKV();
    const env = { BOT_KV: kv };

    await updateRunsIndex(env, '1001', '2026-03-23T10:00:00Z');

    const raw = await kv.get('flaky-runs-index');
    const index = JSON.parse(raw);

    expect(index.length).toBe(1);
    expect(index[0].buildId).toBe('1001');
  });

  it('prepends new builds (most recent first)', async () => {
    const kv = createMockKV();
    const env = { BOT_KV: kv };

    await updateRunsIndex(env, '1001', '2026-03-22T10:00:00Z');
    await updateRunsIndex(env, '1002', '2026-03-23T10:00:00Z');

    const raw = await kv.get('flaky-runs-index');
    const index = JSON.parse(raw);

    expect(index.length).toBe(2);
    expect(index[0].buildId).toBe('1002'); // most recent first
    expect(index[1].buildId).toBe('1001');
  });

  it('prevents duplicate buildIds', async () => {
    const kv = createMockKV();
    const env = { BOT_KV: kv };

    await updateRunsIndex(env, '1001', '2026-03-23T10:00:00Z');
    await updateRunsIndex(env, '1001', '2026-03-23T10:00:00Z');

    const raw = await kv.get('flaky-runs-index');
    const index = JSON.parse(raw);

    expect(index.length).toBe(1);
  });

  it('caps at 100 entries', async () => {
    const kv = createMockKV();
    const env = { BOT_KV: kv };

    // Insert 105 builds
    for (let i = 0; i < 105; i++) {
      await updateRunsIndex(env, `build-${i}`, `2026-03-23T${String(i).padStart(2, '0')}:00:00Z`);
    }

    const raw = await kv.get('flaky-runs-index');
    const index = JSON.parse(raw);

    expect(index.length).toBe(100);
    // Most recent should be first
    expect(index[0].buildId).toBe('build-104');
  });
});

// ─── truncate ───────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns empty string for null/undefined', () => {
    expect(truncate(null, 10)).toBe('');
    expect(truncate(undefined, 10)).toBe('');
    expect(truncate('', 10)).toBe('');
  });

  it('returns full string if under max length', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and adds ellipsis if over max length', () => {
    expect(truncate('hello world', 5)).toBe('hello…');
  });

  it('returns exact string at boundary', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });
});

// ─── esc ────────────────────────────────────────────────────────────────────

describe('esc', () => {
  it('returns empty string for null/undefined', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc('')).toBe('');
  });

  it('escapes HTML entities', () => {
    expect(esc('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('escapes ampersands', () => {
    expect(esc('foo & bar')).toBe('foo &amp; bar');
  });
});

// ─── shortenTestName ────────────────────────────────────────────────────────

describe('shortenTestName', () => {
  it('returns empty for null/undefined', () => {
    expect(shortenTestName(null)).toBe('');
    expect(shortenTestName(undefined)).toBe('');
    expect(shortenTestName('')).toBe('');
  });

  it('shortens fully-qualified test names to spec file segment', () => {
    const name = 'BindTuning.AdminApp.Tests.Homepage.spec.ts > Homepage > should load';
    const result = shortenTestName(name);
    expect(result).toContain('spec.ts');
    expect(result).toContain('should load');
  });

  it('truncates very long names that lack spec/test', () => {
    const name = 'A'.repeat(100);
    const result = shortenTestName(name);
    expect(result.length).toBeLessThanOrEqual(81); // "…" + 79 chars
    expect(result.startsWith('…')).toBe(true);
  });

  it('returns short names unchanged', () => {
    expect(shortenTestName('test.A')).toBe('test.A');
  });
});

// ─── formatDate ─────────────────────────────────────────────────────────────

describe('formatDate', () => {
  it('returns "—" for null/undefined', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
  });

  it('formats a valid ISO date string', () => {
    const result = formatDate('2026-03-23T10:30:00Z');
    // Should contain month and day at minimum
    expect(result).toMatch(/Mar/);
    expect(result).toMatch(/23/);
  });
});

// ─── Full flow simulation (mock KV + mock fetch) ────────────────────────────

describe('Full ingest flow simulation', () => {
  it('correctly identifies flaky tests from realistic Azure DevOps API data', () => {
    // Simulate Azure DevOps test results for a build with retries
    const azureResults = [
      // Test 1: Passes on first try — NOT flaky
      {
        automatedTestName: 'homepage.spec.ts > Homepage > should display title',
        testCaseTitle: 'should display title',
        outcome: 'Passed',
        durationInMs: 3500,
      },
      // Test 2: Fails first, passes on retry — FLAKY
      {
        automatedTestName: 'dashboard.spec.ts > Dashboard > should load charts',
        testCaseTitle: 'should load charts',
        outcome: 'Failed',
        durationInMs: 5000,
        errorMessage: 'Timeout 30000ms exceeded waiting for selector ".chart-container"',
        stackTrace: 'at Dashboard.spec.ts:42:5',
      },
      {
        automatedTestName: 'dashboard.spec.ts > Dashboard > should load charts',
        testCaseTitle: 'should load charts',
        outcome: 'Passed',
        durationInMs: 4200,
      },
      // Test 3: Fails all retries — NOT flaky (consistently failing)
      {
        automatedTestName: 'catalog.spec.ts > Catalog > should filter products',
        testCaseTitle: 'should filter products',
        outcome: 'Failed',
        durationInMs: 2000,
        errorMessage: 'Element not found: .filter-dropdown',
      },
      {
        automatedTestName: 'catalog.spec.ts > Catalog > should filter products',
        testCaseTitle: 'should filter products',
        outcome: 'Failed',
        durationInMs: 2100,
        errorMessage: 'Element not found: .filter-dropdown',
      },
      // Test 4: Fails twice, passes on third attempt — FLAKY
      {
        automatedTestName: 'policies.spec.ts > Policies > should save policy',
        testCaseTitle: 'should save policy',
        outcome: 'Failed',
        durationInMs: 8000,
        errorMessage: 'Request timed out: POST /api/policies',
      },
      {
        automatedTestName: 'policies.spec.ts > Policies > should save policy',
        testCaseTitle: 'should save policy',
        outcome: 'Failed',
        durationInMs: 8000,
        errorMessage: 'Request timed out: POST /api/policies',
      },
      {
        automatedTestName: 'policies.spec.ts > Policies > should save policy',
        testCaseTitle: 'should save policy',
        outcome: 'Passed',
        durationInMs: 3500,
      },
      // Test 5: NotExecuted — ignored
      {
        automatedTestName: 'skipped.spec.ts > Skipped > should run',
        testCaseTitle: 'should run',
        outcome: 'NotExecuted',
        durationInMs: 0,
      },
    ];

    const { flakyTests, stats } = detectFlakiness(azureResults);

    // Should detect 2 flaky tests
    expect(flakyTests.length).toBe(2);
    const flakyNames = flakyTests.map(f => f.testName).sort();
    expect(flakyNames).toEqual([
      'dashboard.spec.ts > Dashboard > should load charts',
      'policies.spec.ts > Policies > should save policy',
    ]);

    // Stats
    expect(stats.total).toBe(5); // 5 unique test names
    expect(stats.passed).toBe(3); // homepage (pass) + dashboard (flaky->pass) + policies (flaky->pass)
    expect(stats.failed).toBe(1); // catalog (consistently failing)
    // duration: all attempts summed
    expect(stats.duration).toBe(3500 + 5000 + 4200 + 2000 + 2100 + 8000 + 8000 + 3500 + 0);

    // Error messages captured from first failed attempt
    const dashboardFlaky = flakyTests.find(f => f.testName.includes('Dashboard'));
    expect(dashboardFlaky.errorMessage).toContain('Timeout 30000ms');

    const policiesFlaky = flakyTests.find(f => f.testName.includes('Policies'));
    expect(policiesFlaky.errorMessage).toContain('Request timed out');
  });

  it('end-to-end: upsert flaky tests + update runs index + verify KV state', async () => {
    const kv = createMockKV();
    const env = { BOT_KV: kv };

    // Simulate two builds with overlapping flaky tests
    const build1Flaky = [
      { testName: 'test.A', errorMessage: 'timeout on build 1' },
      { testName: 'test.B', errorMessage: 'network error on build 1' },
    ];
    const build2Flaky = [
      { testName: 'test.A', errorMessage: 'timeout on build 2' },
      { testName: 'test.C', errorMessage: 'new flake on build 2' },
    ];

    // Build 1
    for (const f of build1Flaky) {
      await upsertFlakyTest(env, f, '1001', '2026-03-22T10:00:00Z');
    }
    await updateRunsIndex(env, '1001', '2026-03-22T10:00:00Z');

    // Build 2
    for (const f of build2Flaky) {
      await upsertFlakyTest(env, f, '1002', '2026-03-23T10:00:00Z');
    }
    await updateRunsIndex(env, '1002', '2026-03-23T10:00:00Z');

    // Verify test.A has 2 occurrences
    const testA = JSON.parse(await kv.get('flaky:test.A'));
    expect(testA.totalFlakes).toBe(2);
    expect(testA.occurrences.length).toBe(2);
    expect(testA.firstSeen).toBe('2026-03-22T10:00:00Z');
    expect(testA.lastSeen).toBe('2026-03-23T10:00:00Z');

    // Verify test.B has 1 occurrence (only in build 1)
    const testB = JSON.parse(await kv.get('flaky:test.B'));
    expect(testB.totalFlakes).toBe(1);

    // Verify test.C has 1 occurrence (only in build 2)
    const testC = JSON.parse(await kv.get('flaky:test.C'));
    expect(testC.totalFlakes).toBe(1);

    // Verify runs index
    const index = JSON.parse(await kv.get('flaky-runs-index'));
    expect(index.length).toBe(2);
    expect(index[0].buildId).toBe('1002'); // most recent first
    expect(index[1].buildId).toBe('1001');
  });
});

import { describe, it, expect } from 'vitest';
import {
  computeDiff,
  calculateRisk,
  riskLevel,
  scanForSecrets,
  truncateDiffAtHunkBoundary,
  SECRET_PATTERNS,
} from '../src/review-worker.js';

// ─── computeDiff ────────────────────────────────────────────────────────────

describe('computeDiff', () => {
  it('returns empty diff for identical texts', () => {
    const result = computeDiff('hello\nworld', 'hello\nworld');
    expect(result.diff).toBe('');
    expect(result.changedLines).toEqual([]);
  });

  it('detects added lines', () => {
    const result = computeDiff('line1\nline2', 'line1\nline2\nline3');
    expect(result.diff).toContain('+');
    expect(result.changedLines.length).toBeGreaterThan(0);
  });

  it('detects deleted lines', () => {
    const result = computeDiff('line1\nline2\nline3', 'line1\nline3');
    expect(result.diff).toContain('-');
  });

  it('detects changed lines', () => {
    const result = computeDiff('hello world', 'hello earth');
    expect(result.diff).not.toBe('');
  });

  it('handles empty old text (all new)', () => {
    const result = computeDiff('', 'new line');
    expect(result.diff).toContain('+');
    expect(result.changedLines.length).toBeGreaterThan(0);
  });

  it('handles empty new text (all deleted)', () => {
    const result = computeDiff('old line', '');
    expect(result.diff).toContain('-');
  });

  it('handles null inputs', () => {
    const result = computeDiff(null, null);
    expect(result.diff).toBe('');
    expect(result.changedLines).toEqual([]);
  });

  it('includes context lines around changes', () => {
    const oldLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[15] = 'CHANGED LINE 16';
    const result = computeDiff(oldLines.join('\n'), newLines.join('\n'));
    // Should have context lines (not just the changed line)
    expect(result.diff).toContain('@@ line');
    expect(result.diff).toContain('CHANGED LINE 16');
  });
});

// ─── calculateRisk & riskLevel ──────────────────────────────────────────────

describe('calculateRisk', () => {
  it('returns 0 for empty file changes', () => {
    expect(calculateRisk([], 0)).toBe(0);
  });

  it('increases with more files', () => {
    const oneFile = calculateRisk([{ diff: 'x' }], 10);
    const fiveFiles = calculateRisk(
      Array.from({ length: 5 }, () => ({ diff: 'x' })),
      10
    );
    expect(fiveFiles).toBeGreaterThan(oneFile);
  });

  it('increases with more changed lines', () => {
    const fewLines = calculateRisk([{ diff: 'x' }], 5);
    const manyLines = calculateRisk([{ diff: 'x' }], 100);
    expect(manyLines).toBeGreaterThan(fewLines);
  });

  it('adds extra for large diffs', () => {
    const smallDiff = calculateRisk([{ diff: 'x'.repeat(100) }], 10);
    const largeDiff = calculateRisk([{ diff: 'x'.repeat(2000) }], 10);
    expect(largeDiff).toBeGreaterThan(smallDiff);
  });

  it('caps at 100', () => {
    const files = Array.from({ length: 100 }, () => ({ diff: 'x'.repeat(5000) }));
    expect(calculateRisk(files, 10000)).toBe(100);
  });
});

describe('riskLevel', () => {
  it('returns LOW for score < 15', () => {
    expect(riskLevel(0)).toBe('LOW');
    expect(riskLevel(14)).toBe('LOW');
  });

  it('returns MEDIUM for score 15-34', () => {
    expect(riskLevel(15)).toBe('MEDIUM');
    expect(riskLevel(34)).toBe('MEDIUM');
  });

  it('returns HIGH for score >= 35', () => {
    expect(riskLevel(35)).toBe('HIGH');
    expect(riskLevel(100)).toBe('HIGH');
  });
});

// ─── scanForSecrets ─────────────────────────────────────────────────────────

describe('scanForSecrets', () => {
  it('returns empty array for clean code', () => {
    const result = scanForSecrets([
      { path: '/src/foo.cs', diff: '+1: var name = "hello";' },
    ]);
    expect(result).toEqual([]);
  });

  it('detects hardcoded passwords', () => {
    const result = scanForSecrets([
      { path: '/src/config.cs', diff: '+5: password = "supersecret123"' },
    ]);
    expect(result.length).toBe(1);
    expect(result[0].pattern).toBe('Hardcoded password');
    expect(result[0].file).toBe('/src/config.cs');
    expect(result[0].line).toBe(5);
  });

  it('detects API keys', () => {
    const result = scanForSecrets([
      { path: '/src/api.js', diff: '+10: const apiKey = "sk-1234567890abcdef"' },
    ]);
    expect(result.length).toBe(1);
    expect(result[0].pattern).toBe('API key');
  });

  it('detects bearer tokens', () => {
    const result = scanForSecrets([
      { path: '/src/auth.ts', diff: '+3: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef' },
    ]);
    expect(result.length).toBe(1);
    expect(result[0].pattern).toBe('Bearer token');
  });

  it('detects private keys', () => {
    const result = scanForSecrets([
      { path: '/keys/id_rsa', diff: '+1: -----BEGIN RSA PRIVATE KEY-----' },
    ]);
    expect(result.length).toBe(1);
    expect(result[0].pattern).toBe('Private key');
  });

  it('detects GitHub PATs', () => {
    const result = scanForSecrets([
      { path: '/src/gh.js', diff: '+1: const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"' },
    ]);
    expect(result.length).toBe(1);
    expect(result[0].pattern).toBe('GitHub PAT');
  });

  it('detects connection strings', () => {
    const result = scanForSecrets([
      { path: '/src/db.cs', diff: '+7: connectionString = "Server=localhost;Database=test;User=sa;Password=pass"' },
    ]);
    expect(result.length).toBe(1);
    expect(result[0].pattern).toBe('Connection string');
  });

  it('only scans added lines (lines with +)', () => {
    const result = scanForSecrets([
      { path: '/src/config.cs', diff: ' 5: password = "old"\n-6: secret = "removed"\n+7: name = "clean"' },
    ]);
    expect(result).toEqual([]);
  });

  it('reports at most one finding per line', () => {
    const result = scanForSecrets([
      { path: '/src/x.js', diff: '+1: password = "sk_secret_api_key_value"' },
    ]);
    expect(result.length).toBe(1);
  });

  it('handles files with no diff', () => {
    const result = scanForSecrets([{ path: '/src/x.js', diff: '' }]);
    expect(result).toEqual([]);
  });
});

// ─── truncateDiffAtHunkBoundary ─────────────────────────────────────────────

describe('truncateDiffAtHunkBoundary', () => {
  it('returns the full diff if under max length', () => {
    const diff = '@@ line 1 @@\n+1: hello\n---\n';
    expect(truncateDiffAtHunkBoundary(diff, 1000)).toBe(diff);
  });

  it('truncates at the last hunk boundary', () => {
    const diff = '@@ line 1 @@\n+1: hello\n---\n@@ line 10 @@\n+10: world\n---\n';
    const result = truncateDiffAtHunkBoundary(diff, 35);
    expect(result).toContain('---');
    expect(result).not.toContain('world');
  });

  it('truncates at last newline if no hunk boundary found', () => {
    const diff = 'line1\nline2\nline3\nline4';
    const result = truncateDiffAtHunkBoundary(diff, 15);
    expect(result.endsWith('\n') || !result.includes('line4')).toBe(true);
  });

  it('returns full truncation if no newline or boundary', () => {
    const diff = 'a'.repeat(100);
    const result = truncateDiffAtHunkBoundary(diff, 50);
    expect(result.length).toBeLessThanOrEqual(100);
  });
});

import { describe, it, expect } from 'vitest';
import { buildDiffBlock } from '../src/lib/prompts.js';

// ─── buildDiffBlock ──────────────────────────────────────────────────────────

describe('buildDiffBlock', () => {
  it('returns empty string for no file changes', () => {
    expect(buildDiffBlock([])).toBe('');
  });

  it('formats a single new file correctly', () => {
    const result = buildDiffBlock([
      { path: '/src/foo.ts', diff: '+1: const x = 1;', isAdd: true },
    ]);
    expect(result).toContain('### FILE: /src/foo.ts (new file)');
    expect(result).toContain('+1: const x = 1;');
    expect(result).toContain('```');
  });

  it('formats a single edited file correctly', () => {
    const result = buildDiffBlock([
      { path: '/src/bar.ts', diff: '+5: changed line', isAdd: false },
    ]);
    expect(result).toContain('### FILE: /src/bar.ts (edited)');
    expect(result).toContain('+5: changed line');
  });

  it('includes multiple files', () => {
    const result = buildDiffBlock([
      { path: '/a.ts', diff: '+1: a', isAdd: true },
      { path: '/b.ts', diff: '+1: b', isAdd: false },
      { path: '/c.ts', diff: '+1: c', isAdd: true },
    ]);
    expect(result).toContain('/a.ts');
    expect(result).toContain('/b.ts');
    expect(result).toContain('/c.ts');
  });

  it('respects the diff budget and stops adding files', () => {
    const largeFiles = Array.from({ length: 100 }, (_, i) => ({
      path: `/src/file${i}.ts`,
      diff: 'x'.repeat(2000),
      isAdd: false,
    }));

    const result = buildDiffBlock(largeFiles);
    // Should not contain all 100 files — budget is 60000 chars
    expect(result.length).toBeLessThan(65000);
    // But should contain at least some
    expect(result).toContain('file0.ts');
  });

  it('handles file with empty diff', () => {
    const result = buildDiffBlock([
      { path: '/src/empty.ts', diff: '', isAdd: false },
    ]);
    expect(result).toContain('### FILE: /src/empty.ts (edited)');
    expect(result).toContain('```\n\n```');
  });
});

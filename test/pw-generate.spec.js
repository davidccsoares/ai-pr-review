import { describe, it, expect } from 'vitest';
import {
  extractTestBlocks,
  extractTestNames,
  sanitizeJsonStringValues,
} from '../src/pw-generate-worker.js';

// ─── extractTestNames ───────────────────────────────────────────────────────

describe('extractTestNames', () => {
  it('extracts names from test() calls', () => {
    const content = `
      test('should navigate to dashboard', async () => {});
      test('should show error on invalid input', async () => {});
    `;
    const names = extractTestNames(content);
    expect(names).toEqual([
      'should navigate to dashboard',
      'should show error on invalid input',
    ]);
  });

  it('handles double-quoted test names', () => {
    const content = `test("should work", async () => {});`;
    const names = extractTestNames(content);
    expect(names).toEqual(['should work']);
  });

  it('handles backtick-quoted test names', () => {
    const content = 'test(`should handle template`, async () => {});';
    const names = extractTestNames(content);
    expect(names).toEqual(['should handle template']);
  });

  it('returns empty array for no tests', () => {
    const content = 'const x = 42;';
    const names = extractTestNames(content);
    expect(names).toEqual([]);
  });
});

// ─── extractTestBlocks ──────────────────────────────────────────────────────

describe('extractTestBlocks', () => {
  it('extracts a single test block', () => {
    const content = `
  test('should work', async ({ actions }) => {
    await actions.dashboard.goToDashboard();
  });
`;
    const blocks = extractTestBlocks(content);
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toContain("test('should work'");
    expect(blocks[0]).toContain('goToDashboard');
  });

  it('extracts multiple test blocks', () => {
    const content = `
  test('first test', async () => {
    const a = 1;
  });

  test('second test', async () => {
    const b = 2;
  });
`;
    const blocks = extractTestBlocks(content);
    expect(blocks.length).toBe(2);
  });

  it('handles nested braces correctly', () => {
    const content = `
  test('nested braces', async ({ actions }) => {
    if (true) {
      const obj = { key: 'value' };
    }
  });
`;
    const blocks = extractTestBlocks(content);
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toContain("key: 'value'");
  });

  it('returns empty array for content with no tests', () => {
    const content = 'import { test } from "fixture"; const x = 1;';
    const blocks = extractTestBlocks(content);
    expect(blocks).toEqual([]);
  });
});

// ─── sanitizeJsonStringValues ───────────────────────────────────────────────

describe('sanitizeJsonStringValues', () => {
  it('returns valid JSON unchanged', () => {
    const json = '{"key":"value","num":42}';
    expect(sanitizeJsonStringValues(json)).toBe(json);
  });

  it('escapes newlines inside string values', () => {
    const json = '{"key":"line1\nline2"}';
    const result = sanitizeJsonStringValues(json);
    expect(result).toBe('{"key":"line1\\nline2"}');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('escapes tabs inside string values', () => {
    const json = '{"key":"col1\tcol2"}';
    const result = sanitizeJsonStringValues(json);
    expect(result).toBe('{"key":"col1\\tcol2"}');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('escapes carriage returns inside string values', () => {
    const json = '{"key":"line1\rline2"}';
    const result = sanitizeJsonStringValues(json);
    expect(result).toBe('{"key":"line1\\rline2"}');
  });

  it('preserves already-escaped characters', () => {
    const json = '{"key":"already\\nescaped"}';
    const result = sanitizeJsonStringValues(json);
    expect(result).toBe('{"key":"already\\nescaped"}');
  });

  it('strips other control characters', () => {
    const json = '{"key":"hello\x01world"}';
    const result = sanitizeJsonStringValues(json);
    expect(result).toBe('{"key":"helloworld"}');
  });

  it('does not modify structural whitespace', () => {
    const json = '{\n  "key": "value"\n}';
    const result = sanitizeJsonStringValues(json);
    expect(result).toBe(json);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('handles empty strings', () => {
    const json = '{"key":""}';
    expect(sanitizeJsonStringValues(json)).toBe(json);
  });

  it('handles complex nested JSON', () => {
    const json = '[{"filePath":"tests/foo.spec.ts","content":"import { test } from \\"fixture\\";\\ntest()"}]';
    const result = sanitizeJsonStringValues(json);
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

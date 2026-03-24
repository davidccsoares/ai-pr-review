import { describe, it, expect } from 'vitest';
import {
  computeDiff,
  calculateRisk,
  riskLevel,
  scanForSecrets,
  truncateDiffAtHunkBoundary,
  SECRET_PATTERNS,
  extractIssues,
  diffReviewIssues,
  buildFollowUpSection,
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

// ─── extractIssues ──────────────────────────────────────────────────────────

describe('extractIssues', () => {
  it('returns empty array for null/undefined input', () => {
    expect(extractIssues(null)).toEqual([]);
    expect(extractIssues(undefined)).toEqual([]);
  });

  it('returns empty array for empty comments', () => {
    expect(extractIssues([])).toEqual([]);
  });

  it('filters out LGTM comments', () => {
    const comments = [
      { file: '/src/foo.ts', line: 1, comment: 'LGTM' },
      { file: '/src/bar.ts', line: 5, comment: 'Looks good to me (LGTM)' },
    ];
    expect(extractIssues(comments)).toEqual([]);
  });

  it('filters out AI review skipped comments', () => {
    const comments = [
      { file: '/src/foo.ts', line: 1, comment: '⚠️ AI review skipped — daily neuron budget exhausted. Manual review recommended.' },
    ];
    expect(extractIssues(comments)).toEqual([]);
  });

  it('extracts real issues with normalized keys', () => {
    const comments = [
      { file: '/src/foo.ts', line: 10, comment: 'Possible null reference on user.name' },
      { file: '/src/bar.ts', line: 20, comment: 'Missing error handling' },
    ];
    const issues = extractIssues(comments);
    expect(issues).toHaveLength(2);
    expect(issues[0].key).toBe('/src/foo.ts::possible null reference on user.name');
    expect(issues[1].key).toBe('/src/bar.ts::missing error handling');
  });

  it('normalizes whitespace in keys', () => {
    const comments = [
      { file: '/src/foo.ts', line: 10, comment: '  Multiple   spaces   here  ' },
    ];
    const issues = extractIssues(comments);
    expect(issues[0].key).toBe('/src/foo.ts::multiple spaces here');
  });

  it('skips comments without file or comment', () => {
    const comments = [
      { file: '', line: 1, comment: 'No file' },
      { file: '/src/foo.ts', line: 1, comment: '' },
      { line: 1, comment: 'No file field' },
      { file: '/src/foo.ts', line: 1 },
    ];
    expect(extractIssues(comments)).toEqual([]);
  });

  it('preserves original line numbers and comments', () => {
    const comments = [
      { file: '/src/foo.ts', line: 42, comment: 'Bug: off-by-one error' },
    ];
    const issues = extractIssues(comments);
    expect(issues[0].file).toBe('/src/foo.ts');
    expect(issues[0].line).toBe(42);
    expect(issues[0].comment).toBe('Bug: off-by-one error');
  });
});

// ─── diffReviewIssues ───────────────────────────────────────────────────────

describe('diffReviewIssues', () => {
  const makeIssue = (file, comment, line = 1) => ({
    file,
    line,
    comment,
    key: `${file}::${comment.toLowerCase()}`,
  });

  it('returns all previous as resolved when current is empty', () => {
    const prev = [makeIssue('/src/foo.ts', 'null ref')];
    const curr = [];
    const diff = diffReviewIssues(prev, curr);
    expect(diff.resolved).toHaveLength(1);
    expect(diff.stillOpen).toHaveLength(0);
    expect(diff.new).toHaveLength(0);
  });

  it('returns all current as new when previous is empty', () => {
    const prev = [];
    const curr = [makeIssue('/src/foo.ts', 'missing await')];
    const diff = diffReviewIssues(prev, curr);
    expect(diff.resolved).toHaveLength(0);
    expect(diff.stillOpen).toHaveLength(0);
    expect(diff.new).toHaveLength(1);
  });

  it('identifies still-open issues by key', () => {
    const issue = makeIssue('/src/foo.ts', 'null ref');
    const diff = diffReviewIssues([issue], [{ ...issue, line: 15 }]); // line changed but key same
    expect(diff.resolved).toHaveLength(0);
    expect(diff.stillOpen).toHaveLength(1);
    expect(diff.new).toHaveLength(0);
  });

  it('handles mixed resolved, open, and new', () => {
    const prev = [
      makeIssue('/src/a.ts', 'issue one'),
      makeIssue('/src/b.ts', 'issue two'),
    ];
    const curr = [
      makeIssue('/src/b.ts', 'issue two', 20), // still open (line shifted)
      makeIssue('/src/c.ts', 'issue three'),     // new
    ];
    const diff = diffReviewIssues(prev, curr);
    expect(diff.resolved).toHaveLength(1); // issue one resolved
    expect(diff.resolved[0].comment).toBe('issue one');
    expect(diff.stillOpen).toHaveLength(1); // issue two still open
    expect(diff.stillOpen[0].comment).toBe('issue two');
    expect(diff.new).toHaveLength(1); // issue three is new
    expect(diff.new[0].comment).toBe('issue three');
  });

  it('returns empty results for both empty', () => {
    const diff = diffReviewIssues([], []);
    expect(diff.resolved).toHaveLength(0);
    expect(diff.stillOpen).toHaveLength(0);
    expect(diff.new).toHaveLength(0);
  });
});

// ─── buildFollowUpSection ───────────────────────────────────────────────────

describe('buildFollowUpSection', () => {
  const makeIssue = (file, comment, line = 1) => ({
    file,
    line,
    comment,
    key: `${file}::${comment.toLowerCase()}`,
  });

  it('includes iteration number in header', () => {
    const diff = { resolved: [], stillOpen: [], new: [] };
    const result = buildFollowUpSection(diff, 3);
    expect(result).toContain('iteration #3');
  });

  it('shows resolved issues with strikethrough', () => {
    const diff = {
      resolved: [makeIssue('/src/foo.ts', 'null ref', 10)],
      stillOpen: [],
      new: [],
    };
    const result = buildFollowUpSection(diff, 2);
    expect(result).toContain('1 issue resolved');
    expect(result).toContain('~`foo.ts`');
    expect(result).toContain('All previous issues have been addressed');
  });

  it('shows still-open issues', () => {
    const diff = {
      resolved: [],
      stillOpen: [makeIssue('/src/bar.ts', 'missing await', 5)],
      new: [],
    };
    const result = buildFollowUpSection(diff, 2);
    expect(result).toContain('1 issue still open');
    expect(result).toContain('`bar.ts`');
    expect(result).toContain('missing await');
  });

  it('shows new issues', () => {
    const diff = {
      resolved: [],
      stillOpen: [],
      new: [makeIssue('/src/c.ts', 'security risk', 20)],
    };
    const result = buildFollowUpSection(diff, 2);
    expect(result).toContain('1 new issue');
    expect(result).toContain('`c.ts`');
  });

  it('pluralizes correctly for multiple items', () => {
    const diff = {
      resolved: [makeIssue('/a', 'x'), makeIssue('/b', 'y')],
      stillOpen: [makeIssue('/c', 'z'), makeIssue('/d', 'w'), makeIssue('/e', 'v')],
      new: [],
    };
    const result = buildFollowUpSection(diff, 4);
    expect(result).toContain('2 issues resolved');
    expect(result).toContain('3 issues still open');
  });

  it('does not show celebration when issues remain', () => {
    const diff = {
      resolved: [makeIssue('/a', 'x')],
      stillOpen: [makeIssue('/b', 'y')],
      new: [],
    };
    const result = buildFollowUpSection(diff, 2);
    expect(result).not.toContain('All previous issues have been addressed');
  });

  it('does not show celebration when new issues exist', () => {
    const diff = {
      resolved: [makeIssue('/a', 'x')],
      stillOpen: [],
      new: [makeIssue('/b', 'y')],
    };
    const result = buildFollowUpSection(diff, 2);
    expect(result).not.toContain('All previous issues have been addressed');
  });

  it('ends with separator', () => {
    const diff = { resolved: [], stillOpen: [], new: [] };
    const result = buildFollowUpSection(diff, 2);
    expect(result).toContain('---');
  });
});

// ─── Re-review KV round-trip simulation ─────────────────────────────────────

describe('re-review round-trip', () => {
  const makeComment = (file, line, comment) => ({ file, line, comment });

  it('simulates full first-review → push → second-review flow', () => {
    // ── First review: AI finds 3 issues ──
    const firstReviewComments = [
      makeComment('/src/foo.ts', 10, 'Possible null reference on user.name'),
      makeComment('/src/foo.ts', 25, 'Missing error handling for async call'),
      makeComment('/src/bar.ts', 5, 'LGTM'),  // should be filtered
      makeComment('/src/baz.ts', 8, 'Hardcoded timeout should be a constant'),
    ];

    const firstIssues = extractIssues(firstReviewComments);
    expect(firstIssues).toHaveLength(3); // LGTM filtered out

    // Simulate KV storage (JSON round-trip)
    const stored = JSON.parse(JSON.stringify({
      issues: firstIssues,
      reviewNumber: 1,
      timestamp: Date.now(),
    }));

    // ── Developer pushes a fix for the null reference and error handling ──
    // ── Second review: AI finds 1 old issue resolved, 1 still there, 1 new ──
    const secondReviewComments = [
      // null reference fixed → not in this list
      // error handling still there but line shifted
      makeComment('/src/foo.ts', 30, 'Missing error handling for async call'),
      // hardcoded timeout still there
      makeComment('/src/baz.ts', 8, 'Hardcoded timeout should be a constant'),
      // new issue found
      makeComment('/src/new-file.ts', 3, 'Unused import'),
    ];

    const secondIssues = extractIssues(secondReviewComments);
    expect(secondIssues).toHaveLength(3);

    // Load from "KV" (simulated)
    const previousIssues = stored.issues;
    const reviewNumber = stored.reviewNumber + 1;

    const diff = diffReviewIssues(previousIssues, secondIssues);

    // The null reference was fixed → resolved
    expect(diff.resolved).toHaveLength(1);
    expect(diff.resolved[0].comment).toBe('Possible null reference on user.name');

    // Error handling + hardcoded timeout still open (matched by comment text, not line)
    expect(diff.stillOpen).toHaveLength(2);
    const stillOpenComments = diff.stillOpen.map(i => i.comment);
    expect(stillOpenComments).toContain('Missing error handling for async call');
    expect(stillOpenComments).toContain('Hardcoded timeout should be a constant');

    // Unused import is new
    expect(diff.new).toHaveLength(1);
    expect(diff.new[0].comment).toBe('Unused import');

    // Build the follow-up section
    const section = buildFollowUpSection(diff, reviewNumber);
    expect(section).toContain('iteration #2');
    expect(section).toContain('1 issue resolved');
    expect(section).toContain('2 issues still open');
    expect(section).toContain('1 new issue');
    expect(section).not.toContain('All previous issues have been addressed');
  });

  it('shows celebration when all issues are resolved', () => {
    const firstComments = [
      makeComment('/src/foo.ts', 10, 'Bug found'),
    ];
    const firstIssues = extractIssues(firstComments);

    // Developer fixes everything, second review is clean
    const secondComments = [
      makeComment('/src/foo.ts', 1, 'LGTM'),
    ];
    const secondIssues = extractIssues(secondComments);
    expect(secondIssues).toHaveLength(0);

    const diff = diffReviewIssues(firstIssues, secondIssues);
    expect(diff.resolved).toHaveLength(1);
    expect(diff.stillOpen).toHaveLength(0);
    expect(diff.new).toHaveLength(0);

    const section = buildFollowUpSection(diff, 2);
    expect(section).toContain('All previous issues have been addressed');
  });

  it('handles AI rephrasing same issue as resolved+new (worst case)', () => {
    // AI says "null ref" in review 1, "could be null" in review 2 — different wording
    const firstIssues = extractIssues([
      makeComment('/src/foo.ts', 10, 'Possible null reference on user.name'),
    ]);
    const secondIssues = extractIssues([
      makeComment('/src/foo.ts', 10, 'user.name could be null here'),
    ]);

    const diff = diffReviewIssues(firstIssues, secondIssues);
    // Different wording = different key → old shows as resolved, new shows as new
    expect(diff.resolved).toHaveLength(1);
    expect(diff.stillOpen).toHaveLength(0);
    expect(diff.new).toHaveLength(1);
    // This is the known limitation — conservative, not incorrect
  });
});

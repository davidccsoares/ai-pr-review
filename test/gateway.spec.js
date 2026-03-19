import { describe, it, expect } from 'vitest';
import {
  classifyFiles,
  computePrLabels,
  buildBacklogContext,
  stripHtml,
  SKIP_PATTERNS,
  PRIORITY_KEYWORDS,
} from '../src/worker.js';

// ─── stripHtml ──────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('returns empty string for null/undefined', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml('')).toBe('');
  });

  it('strips basic HTML tags', () => {
    expect(stripHtml('<p>Hello</p>')).toBe('Hello');
    expect(stripHtml('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
  });

  it('converts <br> to newlines', () => {
    expect(stripHtml('line1<br>line2')).toBe('line1\nline2');
    expect(stripHtml('line1<br/>line2')).toBe('line1\nline2');
    expect(stripHtml('line1<br />line2')).toBe('line1\nline2');
  });

  it('converts block elements to newlines', () => {
    const result = stripHtml('<p>para1</p><p>para2</p>');
    // Block tags become newlines; consecutive newlines are collapsed to \n\n
    expect(result).toContain('para1');
    expect(result).toContain('para2');
    expect(result).toMatch(/para1\n+para2/);
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('&lt;div&gt; &amp; &quot;hello&quot;')).toBe('<div> & "hello"');
    expect(stripHtml('a&nbsp;b')).toBe('a b');
  });

  it('collapses multiple newlines', () => {
    expect(stripHtml('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims whitespace', () => {
    expect(stripHtml('  <p> hello </p>  ')).toBe('hello');
  });
});

// ─── classifyFiles ──────────────────────────────────────────────────────────

describe('classifyFiles', () => {
  function makeEntry(path, changeType = 'edit') {
    return { item: { path }, changeType, changeTrackingId: 1 };
  }

  it('skips lock files', () => {
    const result = classifyFiles([makeEntry('/package-lock.json')]);
    expect(result.skip.length).toBe(1);
    expect(result.high.length).toBe(0);
    expect(result.low.length).toBe(0);
  });

  it('skips binary files', () => {
    const result = classifyFiles([makeEntry('/images/logo.png')]);
    expect(result.skip.length).toBe(1);
  });

  it('skips C# generated files', () => {
    const result = classifyFiles([
      makeEntry('/src/Models/Foo.designer.cs'),
      makeEntry('/src/Models/Bar.g.cs'),
      makeEntry('/Properties/AssemblyInfo.cs'),
    ]);
    expect(result.skip.length).toBe(3);
  });

  it('skips markdown and docs', () => {
    const result = classifyFiles([
      makeEntry('/README.md'),
      makeEntry('/docs/guide.txt'),
      makeEntry('/LICENSE'),
    ]);
    expect(result.skip.length).toBe(3);
  });

  it('classifies .cs files as HIGH', () => {
    const result = classifyFiles([makeEntry('/src/Controllers/UserController.cs')]);
    expect(result.high.length).toBe(1);
    expect(result.high[0].path).toBe('/src/Controllers/UserController.cs');
  });

  it('classifies Angular components as HIGH with correct priority', () => {
    const result = classifyFiles([
      makeEntry('/src/app/dashboard.component.ts'),
      makeEntry('/src/app/auth.service.ts'),
    ]);
    expect(result.high.length).toBe(2);
    // component.ts should have priority 9, service.ts should have 8
    expect(result.high[0].priorityScore).toBe(9);
    expect(result.high[1].priorityScore).toBe(8);
  });

  it('classifies Angular template (.component.html) as HIGH', () => {
    const result = classifyFiles([makeEntry('/src/app/dashboard.component.html')]);
    expect(result.high.length).toBe(1);
    expect(result.high[0].priorityScore).toBe(6);
  });

  it('classifies test files as LOW', () => {
    const result = classifyFiles([
      makeEntry('/src/app/dashboard.spec.ts'),
      makeEntry('/tests/unit/foo.test.js'),
    ]);
    expect(result.high.length).toBe(0);
    expect(result.low.length).toBe(2);
  });

  it('classifies CSS/SCSS as LOW', () => {
    const result = classifyFiles([
      makeEntry('/src/styles/main.css'),
      makeEntry('/src/app/theme.scss'),
    ]);
    expect(result.low.length).toBe(2);
  });

  it('ignores directories (paths ending with /)', () => {
    const result = classifyFiles([makeEntry('/src/app/')]);
    expect(result.skip.length).toBe(0);
    expect(result.high.length).toBe(0);
    expect(result.low.length).toBe(0);
  });

  it('ignores entries without a path', () => {
    const result = classifyFiles([{ changeType: 'edit' }]);
    expect(result.skip.length).toBe(0);
    expect(result.high.length).toBe(0);
    expect(result.low.length).toBe(0);
  });

  it('ignores delete change types', () => {
    const result = classifyFiles([makeEntry('/src/app/foo.ts', 'delete')]);
    expect(result.high.length).toBe(0);
    expect(result.low.length).toBe(0);
  });

  it('handles numeric changeType values', () => {
    const result = classifyFiles([
      { item: { path: '/src/foo.ts' }, changeType: 2, changeTrackingId: 1 }, // edit
      { item: { path: '/src/bar.ts' }, changeType: 1, changeTrackingId: 2 }, // add
    ]);
    expect(result.high.length).toBe(2);
  });

  it('sorts HIGH files by priority score descending', () => {
    const result = classifyFiles([
      makeEntry('/src/helpers/util.ts'),           // score 3
      makeEntry('/src/UserController.cs'),          // score 10
      makeEntry('/src/app/auth.service.ts'),        // score 8
    ]);
    expect(result.high.length).toBe(3);
    expect(result.high[0].priorityScore).toBeGreaterThanOrEqual(result.high[1].priorityScore);
    expect(result.high[1].priorityScore).toBeGreaterThanOrEqual(result.high[2].priorityScore);
  });

  it('classifies unknown extensions as LOW', () => {
    const result = classifyFiles([makeEntry('/data/config.yaml')]);
    expect(result.low.length).toBe(1);
  });
});

// ─── computePrLabels ────────────────────────────────────────────────────────

describe('computePrLabels', () => {
  it('returns docs-only when all files are skipped', () => {
    const labels = computePrLabels({
      skip: [{ path: '/README.md' }],
      high: [],
      low: [],
    });
    expect(labels).toEqual(['docs-only']);
  });

  it('returns empty array when no files at all', () => {
    const labels = computePrLabels({ skip: [], high: [], low: [] });
    expect(labels).toEqual([]);
  });

  it('adds large-pr label for 15+ reviewable files', () => {
    const high = Array.from({ length: 15 }, (_, i) => ({ path: `/src/file${i}.cs` }));
    const labels = computePrLabels({ skip: [], high, low: [] });
    expect(labels).toContain('large-pr');
  });

  it('adds high-risk label for 5+ high-priority files', () => {
    const high = Array.from({ length: 5 }, (_, i) => ({ path: `/src/file${i}.cs` }));
    const labels = computePrLabels({ skip: [], high, low: [] });
    expect(labels).toContain('high-risk');
  });

  it('detects backend files', () => {
    const labels = computePrLabels({
      skip: [],
      high: [{ path: '/src/Controller.cs' }],
      low: [],
    });
    expect(labels).toContain('backend');
    expect(labels).not.toContain('frontend');
  });

  it('detects frontend files', () => {
    const labels = computePrLabels({
      skip: [],
      high: [{ path: '/src/app/dashboard.component.ts' }],
      low: [],
    });
    expect(labels).toContain('frontend');
    expect(labels).not.toContain('backend');
  });

  it('detects both frontend and backend', () => {
    const labels = computePrLabels({
      skip: [],
      high: [
        { path: '/src/Controller.cs' },
        { path: '/src/app/dashboard.component.ts' },
      ],
      low: [],
    });
    expect(labels).toContain('backend');
    expect(labels).toContain('frontend');
  });
});

// ─── buildBacklogContext ────────────────────────────────────────────────────

describe('buildBacklogContext', () => {
  it('returns empty string for no work items', () => {
    expect(buildBacklogContext([])).toBe('');
  });

  it('includes work item type, id, title, and state', () => {
    const result = buildBacklogContext([
      {
        type: 'User Story',
        id: 42,
        title: 'Add login page',
        state: 'Active',
        tags: 'sprint-1',
        description: 'Implement login',
        acceptanceCriteria: 'Must have SSO',
      },
    ]);
    expect(result).toContain('User Story #42');
    expect(result).toContain('Add login page');
    expect(result).toContain('State: Active');
    expect(result).toContain('Tags: sprint-1');
    expect(result).toContain('Implement login');
    expect(result).toContain('Must have SSO');
  });

  it('includes parent work item info', () => {
    const result = buildBacklogContext([
      {
        type: 'Task',
        id: 100,
        title: 'Build form',
        state: 'New',
        tags: '',
        description: '',
        acceptanceCriteria: '',
        parent: {
          type: 'Feature',
          id: 50,
          title: 'User management',
          acceptanceCriteria: 'Manage users and roles',
        },
      },
    ]);
    expect(result).toContain('Parent Feature #50');
    expect(result).toContain('User management');
    expect(result).toContain('Manage users and roles');
  });

  it('respects MAX_BACKLOG_SIZE and truncates', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      type: 'Task',
      id: i,
      title: 'A'.repeat(100),
      state: 'Active',
      tags: '',
      description: 'D'.repeat(500),
      acceptanceCriteria: 'AC'.repeat(250),
    }));
    const result = buildBacklogContext(items);
    expect(result.length).toBeLessThanOrEqual(4000); // generous upper bound
  });
});

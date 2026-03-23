/**
 * Diff algorithms for PR review.
 * Myers diff (optimised for Cloudflare Workers) + fallback strategies.
 *
 * Shared across:
 *  - review-worker.js  (computes file diffs for AI review)
 *  - review.spec.js    (unit tests)
 *  - dry-run tests     (validates diff logic)
 */

export const CONTEXT_LINES = 10;

// ─── Myers Diff ─────────────────────────────────────────────────────────────

/**
 * Myers diff algorithm (optimised for Cloudflare Workers).
 * Computes the shortest edit script between oldLines and newLines arrays.
 * Returns an array of operations: { op: 'equal'|'insert'|'delete', oldLine?, newLine?, text }
 */
function myersDiff(oldLines, newLines) {
  const N = oldLines.length;
  const M = newLines.length;

  // For very large files, fall back to a simpler approach to avoid memory/time issues
  if (N + M > 20000) {
    return simpleFallbackDiff(oldLines, newLines);
  }

  const MAX = N + M;
  const size = 2 * MAX + 1;
  const vForward = new Int32Array(size);
  const vBackward = new Int32Array(size);

  // Find middle snake using divide-and-conquer Myers
  function findMiddleSnake(aStart, aEnd, bStart, bEnd) {
    const n = aEnd - aStart;
    const m = bEnd - bStart;
    if (n === 0 && m === 0) return null;
    if (n === 0) {
      // All inserts
      const ops = [];
      for (let j = bStart; j < bEnd; j++) {
        ops.push({ op: "insert", newLine: j + 1, text: newLines[j] });
      }
      return { ops };
    }
    if (m === 0) {
      // All deletes
      const ops = [];
      for (let i = aStart; i < aEnd; i++) {
        ops.push({ op: "delete", oldLine: i + 1, text: oldLines[i] });
      }
      return { ops };
    }

    const delta = n - m;
    const odd = (delta & 1) !== 0;
    const midOffset = MAX;

    vForward.fill(0);
    vBackward.fill(0);
    vForward[midOffset + 1] = 0;
    vBackward[midOffset + 1] = 0;

    for (let d = 0; d <= Math.ceil((n + m) / 2); d++) {
      // Forward
      for (let k = -d; k <= d; k += 2) {
        let x;
        if (k === -d || (k !== d && vForward[midOffset + k - 1] < vForward[midOffset + k + 1])) {
          x = vForward[midOffset + k + 1];
        } else {
          x = vForward[midOffset + k - 1] + 1;
        }
        let y = x - k;
        const x0 = x, y0 = y;
        while (x < n && y < m && oldLines[aStart + x] === newLines[bStart + y]) {
          x++; y++;
        }
        vForward[midOffset + k] = x;
        if (odd && k >= delta - (d - 1) && k <= delta + (d - 1)) {
          if (x + vBackward[midOffset - k + delta] >= n) {
            // Found the middle snake
            return { x: aStart + x0, y: bStart + y0, u: aStart + x, v: bStart + y };
          }
        }
      }
      // Backward
      for (let k = -d; k <= d; k += 2) {
        let x;
        if (k === -d || (k !== d && vBackward[midOffset + k - 1] < vBackward[midOffset + k + 1])) {
          x = vBackward[midOffset + k + 1];
        } else {
          x = vBackward[midOffset + k - 1] + 1;
        }
        let y = x - k;
        while (x < n && y < m && oldLines[aEnd - 1 - x] === newLines[bEnd - 1 - y]) {
          x++; y++;
        }
        vBackward[midOffset + k] = x;
        if (!odd && k >= -delta - d && k <= -delta + d) {
          if (x + vForward[midOffset - k + delta] >= n) {
            // Found the middle snake
            const snakeX = aEnd - x, snakeY = bEnd - y;
            return { x: snakeX, y: snakeY, u: aEnd - (x - (x - (aEnd - snakeX - (y - (bEnd - snakeY))))), v: bEnd - (y - (y - (bEnd - snakeY))) };
          }
        }
      }
    }
    // Should never reach here, fallback
    return null;
  }

  // Simple recursive implementation using the middle snake
  function buildDiff(aStart, aEnd, bStart, bEnd) {
    const ops = [];
    if (aStart >= aEnd && bStart >= bEnd) return ops;
    if (aStart >= aEnd) {
      for (let j = bStart; j < bEnd; j++) {
        ops.push({ op: "insert", newLine: j + 1, text: newLines[j] });
      }
      return ops;
    }
    if (bStart >= bEnd) {
      for (let i = aStart; i < aEnd; i++) {
        ops.push({ op: "delete", oldLine: i + 1, text: oldLines[i] });
      }
      return ops;
    }

    // Find longest common prefix
    let prefix = 0;
    while (aStart + prefix < aEnd && bStart + prefix < bEnd && oldLines[aStart + prefix] === newLines[bStart + prefix]) {
      prefix++;
    }
    // Find longest common suffix
    let suffix = 0;
    while (aEnd - 1 - suffix > aStart + prefix - 1 && bEnd - 1 - suffix > bStart + prefix - 1 && oldLines[aEnd - 1 - suffix] === newLines[bEnd - 1 - suffix]) {
      suffix++;
    }

    for (let i = 0; i < prefix; i++) {
      ops.push({ op: "equal", oldLine: aStart + i + 1, newLine: bStart + i + 1, text: newLines[bStart + i] });
    }

    const innerAStart = aStart + prefix;
    const innerAEnd = aEnd - suffix;
    const innerBStart = bStart + prefix;
    const innerBEnd = bEnd - suffix;

    if (innerAStart >= innerAEnd) {
      for (let j = innerBStart; j < innerBEnd; j++) {
        ops.push({ op: "insert", newLine: j + 1, text: newLines[j] });
      }
    } else if (innerBStart >= innerBEnd) {
      for (let i = innerAStart; i < innerAEnd; i++) {
        ops.push({ op: "delete", oldLine: i + 1, text: oldLines[i] });
      }
    } else {
      // Use a simpler LCS for the inner part
      const innerOps = lcsInnerDiff(oldLines, newLines, innerAStart, innerAEnd, innerBStart, innerBEnd);
      ops.push(...innerOps);
    }

    for (let i = 0; i < suffix; i++) {
      ops.push({ op: "equal", oldLine: aEnd - suffix + i + 1, newLine: bEnd - suffix + i + 1, text: newLines[bEnd - suffix + i] });
    }

    return ops;
  }

  const ops = buildDiff(0, N, 0, M);
  return ops;
}

// ─── LCS Inner Diff ─────────────────────────────────────────────────────────

/**
 * LCS-based inner diff for smaller chunks. Uses a hunt-McIlroy style approach:
 * hash matching lines then building the edit script.
 */
function lcsInnerDiff(oldLines, newLines, aStart, aEnd, bStart, bEnd) {
  const ops = [];

  // Build a map of new lines → positions for matching
  const newMap = new Map();
  for (let j = bStart; j < bEnd; j++) {
    const line = newLines[j];
    if (!newMap.has(line)) newMap.set(line, []);
    newMap.get(line).push(j);
  }

  // Find matching lines greedily
  let j = bStart;
  for (let i = aStart; i < aEnd; i++) {
    const positions = newMap.get(oldLines[i]);
    if (positions) {
      const match = positions.find(p => p >= j);
      if (match !== undefined) {
        // Output inserts before this match
        while (j < match) {
          ops.push({ op: "insert", newLine: j + 1, text: newLines[j] });
          j++;
        }
        ops.push({ op: "equal", oldLine: i + 1, newLine: j + 1, text: oldLines[i] });
        j++;
        continue;
      }
    }
    ops.push({ op: "delete", oldLine: i + 1, text: oldLines[i] });
  }
  // Remaining new lines are inserts
  while (j < bEnd) {
    ops.push({ op: "insert", newLine: j + 1, text: newLines[j] });
    j++;
  }
  return ops;
}

// ─── Simple Fallback Diff ───────────────────────────────────────────────────

/**
 * Fallback for very large files (>20K total lines): use greedy line matching.
 */
function simpleFallbackDiff(oldLines, newLines) {
  const newMap = new Map();
  for (let j = 0; j < newLines.length; j++) {
    const line = newLines[j];
    if (!newMap.has(line)) newMap.set(line, []);
    newMap.get(line).push(j);
  }

  const ops = [];
  let j = 0;
  for (let i = 0; i < oldLines.length; i++) {
    const positions = newMap.get(oldLines[i]);
    if (positions) {
      const match = positions.find(p => p >= j);
      if (match !== undefined) {
        while (j < match) {
          ops.push({ op: "insert", newLine: j + 1, text: newLines[j] });
          j++;
        }
        ops.push({ op: "equal", oldLine: i + 1, newLine: j + 1, text: oldLines[i] });
        j++;
        continue;
      }
    }
    ops.push({ op: "delete", oldLine: i + 1, text: oldLines[i] });
  }
  while (j < newLines.length) {
    ops.push({ op: "insert", newLine: j + 1, text: newLines[j] });
    j++;
  }
  return ops;
}

// ─── computeDiff ────────────────────────────────────────────────────────────

/**
 * Proper LCS-based diff: correctly identifies inserted, deleted, and changed lines.
 * Unlike positional comparison, this handles line insertions/deletions without
 * causing every subsequent line to appear "changed".
 */
export function computeDiff(oldText, newText) {
  const oldLines = (oldText || "").split("\n");
  const newLines = (newText || "").split("\n");

  const ops = myersDiff(oldLines, newLines);

  // Only keep non-equal ops (the actual changes)
  const changes = ops.filter(op => op.op !== "equal");
  if (changes.length === 0) return { diff: "", changedLines: [] };

  // Group changes into hunks with context
  const changeIndices = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op !== "equal") changeIndices.push(i);
  }

  // Group into hunks: changes separated by more than CONTEXT_LINES*2 equal lines
  const hunks = [];
  let hunkStart = changeIndices[0];
  let hunkEnd = changeIndices[0];
  for (let k = 1; k < changeIndices.length; k++) {
    const gapEqualLines = changeIndices[k] - changeIndices[k - 1] - 1;
    if (gapEqualLines > CONTEXT_LINES * 2) {
      hunks.push({ start: hunkStart, end: hunkEnd });
      hunkStart = changeIndices[k];
    }
    hunkEnd = changeIndices[k];
  }
  hunks.push({ start: hunkStart, end: hunkEnd });

  // Format output
  const output = [];
  const changedLines = [];

  for (const hunk of hunks) {
    const ctxStart = Math.max(0, hunk.start - CONTEXT_LINES);
    const ctxEnd = Math.min(ops.length - 1, hunk.end + CONTEXT_LINES);

    let startNewLine = null;
    for (let i = ctxStart; i <= ctxEnd; i++) {
      if (ops[i].newLine) { startNewLine = ops[i].newLine; break; }
      if (ops[i].oldLine && ops[i].op === "delete") { startNewLine = ops[i].oldLine; break; }
    }
    output.push(`@@ line ${startNewLine || "?"} @@`);

    for (let i = ctxStart; i <= ctxEnd; i++) {
      const op = ops[i];
      if (op.op === "equal") {
        output.push(` ${op.newLine}: ${op.text}`);
      } else if (op.op === "delete") {
        output.push(`-${op.oldLine}: ${op.text}`);
      } else if (op.op === "insert") {
        output.push(`+${op.newLine}: ${op.text}`);
        changedLines.push(op.newLine);
      }
    }
    output.push("---");
  }

  return { diff: output.join("\n"), changedLines };
}

// ─── Truncate at Hunk Boundary ──────────────────────────────────────────────

/**
 * Truncate a diff string at a clean hunk boundary (at a "---" separator)
 * instead of cutting mid-line, which confuses the AI.
 */
export function truncateDiffAtHunkBoundary(diff, maxLen) {
  if (diff.length <= maxLen) return diff;

  // Find the last "---" hunk separator before the limit
  const truncated = diff.substring(0, maxLen);
  const lastHunkEnd = truncated.lastIndexOf("\n---\n");

  if (lastHunkEnd > 0) {
    return truncated.substring(0, lastHunkEnd + 4);
  }

  // No clean boundary found — find last newline at least
  const lastNewline = truncated.lastIndexOf("\n");
  return lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated;
}

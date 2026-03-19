import { orgUrl, AZURE_API_VERSION, AZURE_API_VERSION_FILEDIFFS, fetchFileAtCommit } from "./lib/azure.js";
import { checkNeuronBudget, recordNeuronUsage, NEURON_DAILY_LIMIT } from "./lib/neurons.js";
import { fetchWithTimeout } from "./lib/fetch.js";

const MAX_DIFF_SIZE = 60000;
const MAX_FILE_DIFF = 12000;
const CONTEXT_LINES = 10;
const MAX_BATCH_FILES = 40;
const MAX_BATCHES = 25;
const CF_AI_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
const CF_AI_MODEL_CHEAP = "@cf/meta/llama-3.2-3b-instruct";

// ─── Review Worker — "The Reviewer" ─────────────────────────────────────────
// Receives a batch of file paths + PR metadata from the Gateway worker.
// Fetches diffs, calls AI, self-calls for more batches, posts final review.

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Only POST allowed", { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Extract azureToken from header (preferred for self-calls) or body (service binding calls)
    const headerToken = request.headers.get("X-Azure-Token");
    if (headerToken && !payload.azureToken) {
      payload.azureToken = headerToken;
    }

    // Batch continuation routing — self-calls from previous batch
    if (payload.__isBatchContinuation) {
      console.log(`(log) [Review] Batch continuation #${payload.batchNumber} received`);
      ctx.waitUntil(processBatch(payload, env));
      return new Response("Batch accepted", { status: 202 });
    }

    // Initial batch from gateway
    if (payload.__isReviewRequest) {
      console.log(`(log) [Review] Initial review request for PR ${payload.pr?.id}`);
      ctx.waitUntil(processInitialBatch(payload, env));
      return new Response("Review accepted", { status: 202 });
    }

    return new Response("Unknown payload", { status: 400 });
  },
};

// ─── Diff Algorithms ────────────────────────────────────────────────────────

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

// ─── Risk Scoring ────────────────────────────────────────────────────────────

export function calculateRisk(fileChanges, totalChangedLines) {
  let score = 0;
  score += fileChanges.length * 2;
  score += Math.floor(totalChangedLines / 10);
  for (const fc of fileChanges) {
    if (fc.diff.length > 1500) score += 3;
  }
  return Math.min(score, 100);
}

export function riskLevel(score) {
  if (score < 15) return "LOW";
  if (score < 35) return "MEDIUM";
  return "HIGH";
}

// ─── Secret/Credential Detection ─────────────────────────────────────────────
// Pure regex — zero neuron cost, zero subrequests.

export const SECRET_PATTERNS = [
  { regex: /password\s*[=:]\s*["'][^"']+/i, label: "Hardcoded password" },
  { regex: /api[_-]?key\s*[=:]\s*["'][^"']+/i, label: "API key" },
  { regex: /secret\s*[=:]\s*["'][^"']+/i, label: "Secret value" },
  { regex: /Bearer\s+[A-Za-z0-9._-]{20,}/, label: "Bearer token" },
  { regex: /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, label: "Private key" },
  { regex: /ghp_[A-Za-z0-9]{36}/, label: "GitHub PAT" },
  { regex: /connectionString\s*[=:]\s*["'][^"']+/i, label: "Connection string" },
  { regex: /client[_-]?secret\s*[=:]\s*["'][^"']+/i, label: "Client secret" },
];

/**
 * Scan file diffs for accidentally committed secrets/credentials.
 * Only scans added lines (lines prefixed with "+").
 * Returns array of { file, line, pattern } findings.
 */
export function scanForSecrets(fileChanges) {
  const findings = [];
  for (const fc of fileChanges) {
    if (!fc.diff) continue;
    const lines = fc.diff.split("\n");
    for (const line of lines) {
      // Only scan added lines (prefixed with "+")
      const addMatch = line.match(/^\+(\d+):\s*(.*)/);
      if (!addMatch) continue;
      const lineNum = parseInt(addMatch[1], 10);
      const content = addMatch[2];
      for (const sp of SECRET_PATTERNS) {
        if (sp.regex.test(content)) {
          findings.push({ file: fc.path, line: lineNum, pattern: sp.label });
          break; // One finding per line is enough
        }
      }
    }
  }
  return findings;
}

// ─── Batch Helper: Truncate diff at hunk boundary ──────────────────────────

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

// ─── Batch Helper: Fetch + Diff a batch of files ────────────────────────────

/**
 * Use Azure DevOps File Diffs API to get exact changed line ranges,
 * then fetch the new file content and extract only the changed hunks.
 *
 * Subrequests per batch:
 *  - 1 POST to filediffs API (returns line ranges for ALL files in the batch)
 *  - 1 GET per file to fetch new content
 *  = 1 + N subrequests
 */
async function fetchAndDiffFiles(files, project, repoId, sourceCommit, targetCommit, headers, env) {
  const ORG = orgUrl(env);
  const fileChanges = [];
  let totalChangedLines = 0;

  // 1. Get line-level diffs from Azure for all files in the batch (1 subrequest!)
  const fileDiffParams = files.map((f) => ({ path: f.path, originalPath: f.path }));
  const fileDiffsUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/filediffs?api-version=${AZURE_API_VERSION_FILEDIFFS}`;

  let fileDiffsData = [];
  try {
    console.log(`(log) [Review] Calling filediffs API: base=${targetCommit} target=${sourceCommit} for ${files.length} files`);
    const fileDiffsRes = await fetchWithTimeout(fileDiffsUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        baseVersionCommit: targetCommit,
        targetVersionCommit: sourceCommit,
        fileDiffParams,
      }),
      timeout: 15_000,
    });

    if (fileDiffsRes.ok) {
      const data = await fileDiffsRes.json();
      fileDiffsData = data.value || data || [];
      console.log(`(log) [Review] File diffs API returned data for ${fileDiffsData.length} files`);
      // Debug: log the raw diff blocks
      for (const fd of fileDiffsData) {
        const blocks = fd.lineDiffBlocks || [];
        const nonZero = blocks.filter(b => {
          const ct = typeof b.changeType === "string" ? b.changeType.toLowerCase() : b.changeType;
          return ct !== 0 && ct !== "none";
        });
        console.log(`(log) [Review] File diffs for "${fd.path}": ${blocks.length} total blocks, ${nonZero.length} changed blocks`);
        for (const b of nonZero.slice(0, 10)) {
          console.log(`(log)   block: changeType=${b.changeType} origStart=${b.originalLineNumberStart} origCount=${b.originalLinesCount} modStart=${b.modifiedLineNumberStart} modCount=${b.modifiedLinesCount}`);
        }
        if (nonZero.length > 10) console.log(`(log)   ... and ${nonZero.length - 10} more changed blocks`);
      }
    } else {
      console.error(`(log) [Review] File diffs API failed: ${fileDiffsRes.status}`);
    }
  } catch (e) {
    console.error("(log) [Review] File diffs API error:", e.message);
  }

  // Build a map of path → lineDiffBlocks
  const diffBlocksByPath = new Map();
  for (const fd of fileDiffsData) {
    const p = fd.path || fd.originalPath;
    if (p && fd.lineDiffBlocks) {
      diffBlocksByPath.set(p, fd.lineDiffBlocks);
    }
  }

  // 2. For each file, fetch new content and build diff using Azure's line ranges
  for (const f of files) {
    console.log(`(log) [Review] Processing file (${f.isAdd ? "add" : "edit"}): ${f.path}`);

    const newContent = await fetchFileAtCommit(env, project, repoId, f.path, sourceCommit, headers);

    if (newContent === null) {
      console.log("(log) [Review] Skipping (could not fetch):", f.path);
      continue;
    }

    const newLines = newContent.split("\n");

    if (f.isAdd) {
      // New file — show first 80 lines
      const lines = newLines.slice(0, 80);
      const diff = lines.map((l, idx) => `+${idx + 1}: ${l}`).join("\n");
      const changedLines = lines.map((_, idx) => idx + 1);
      totalChangedLines += changedLines.length;
      fileChanges.push({
        path: f.path,
        changeTrackingId: f.changeTrackingId,
        isAdd: true,
        diff: truncateDiffAtHunkBoundary(diff, MAX_FILE_DIFF),
        changedLines,
      });
      continue;
    }

    // Edited file — use Azure's lineDiffBlocks
    const blocks = diffBlocksByPath.get(f.path);
    if (!blocks || blocks.length === 0) {
      console.log(`(log) [Review] No diff blocks from Azure for ${f.path}, skipping`);
      continue;
    }

    // Build hunks from Azure's lineDiffBlocks
    const output = [];
    const changedLines = [];

    for (const block of blocks) {
      const ct = typeof block.changeType === "string" ? block.changeType.toLowerCase() : block.changeType;
      if (ct === 0 || ct === "none") continue;

      const modStart = block.modifiedLineNumberStart;
      const modCount = block.modifiedLinesCount;
      const isDelete = ct === 2 || ct === "delete";

      const ctxBefore = Math.max(0, modStart - 1 - CONTEXT_LINES);
      const ctxAfter = Math.min(newLines.length, modStart - 1 + modCount + CONTEXT_LINES);

      output.push(`@@ line ${modStart} @@`);

      for (let i = ctxBefore; i < ctxAfter; i++) {
        const lineNum = i + 1;
        const isChanged = lineNum >= modStart && lineNum < modStart + modCount;

        if (isChanged) {
          if (isDelete) {
            output.push(`-${lineNum}: (deleted)`);
          } else {
            if (i < newLines.length) {
              output.push(`+${lineNum}: ${newLines[i]}`);
              changedLines.push(lineNum);
            }
          }
        } else {
          if (i < newLines.length) {
            output.push(` ${lineNum}: ${newLines[i]}`);
          }
        }
      }
      output.push("---");
    }

    if (changedLines.length > 0) {
      const diff = output.join("\n");
      totalChangedLines += changedLines.length;
      console.log(`(log) [Review] ${f.path}: changed lines [${changedLines.slice(0, 10).join(",")}${changedLines.length > 10 ? "..." : ""}] (${changedLines.length} total)`);
      fileChanges.push({
        path: f.path,
        changeTrackingId: f.changeTrackingId,
        isAdd: false,
        diff: truncateDiffAtHunkBoundary(diff, MAX_FILE_DIFF),
        changedLines,
      });
    } else {
      console.log(`(log) [Review] ${f.path}: no modified lines found in diff blocks`);
    }
  }

  return { fileChanges, totalChangedLines };
}

// ─── Batch Helper: Call AI for a batch of file changes ──────────────────────

function buildDiffBlock(fileChanges) {
  let diffBlock = "";
  for (const fc of fileChanges) {
    const header = `\n### FILE: ${fc.path} (${fc.isAdd ? "new file" : "edited"})`;
    const section = `${header}\n\`\`\`\n${fc.diff}\n\`\`\`\n`;
    if (diffBlock.length + section.length > MAX_DIFF_SIZE) {
      console.log("(log) [Review] Diff budget reached, skipping remaining files in this batch");
      break;
    }
    diffBlock += section;
  }
  return diffBlock;
}

async function aiReviewBatch(fileChanges, prTitle, backlogContext, env) {
  const diffBlock = buildDiffBlock(fileChanges);
  const fileList = fileChanges.map((fc) => fc.path).join(", ");

  // Build an explicit list of changed lines per file for the AI
  const changedLinesSummary = fileChanges.map((fc) =>
    `${fc.path}: lines ${fc.changedLines.join(", ")}`
  ).join("\n");

  console.log(`(log) [Review] AI batch review: ${fileChanges.length} files, ${diffBlock.length} chars`);

  const systemPrompt = `You are a senior code reviewer. Review ONLY the changed lines in the PR diff below.
${backlogContext ? "\nYou will also receive linked product backlog items (user stories, tasks, bugs). Use them to:\n- Understand the INTENT behind the changes and validate the code aligns with the requirements.\n- Check if the code changes are actually RELEVANT to the linked work items. If the work item describes a completely different feature or task than what the code changes implement, flag this mismatch.\n" : ""}
OUTPUT FORMAT — respond with ONLY a raw JSON array, no markdown, no code fences:
[{"file":"/path/to/file.cs","line":42,"comment":"Your feedback"}]

RULES:
1. ONLY comment on lines prefixed with "+" (these are the changed/added lines)
2. NEVER comment on context lines (prefixed with a space) or removed lines (prefixed with "-")
3. "file" must exactly match the file path from the diff header
4. "line" must be the exact line number shown after the "+" prefix — ONLY use line numbers from the CHANGED LINES list below
5. NEVER repeat the same line number — one comment per line, max
6. Keep each comment concise (1-2 sentences)
7. Focus on: actual bugs, null reference risks, security vulnerabilities, clear logic errors
8. Do NOT guess or speculate — only flag issues you are certain about
9. Do NOT comment on code style, naming, or formatting
10. If the changed code looks correct, return: [{"file":"/path","line":1,"comment":"LGTM"}] where "line" is the first changed line number
11. Do NOT flag syntax errors like missing braces, unmatched if/else, or try/catch structure — the diff shows partial code and the IDE already catches these${backlogContext ? "\n12. If the code contradicts or clearly misses a requirement from the linked work items, flag it\n13. If the linked work items describe a DIFFERENT feature/task than what the code actually does, add a comment on the first changed line: \"⚠️ Backlog mismatch: the linked work item is about [X] but this code changes [Y]. Verify the correct work item is linked to this PR.\"" : ""}

IMPORTANT: The ONLY valid line numbers you may use in your response are listed below. Any other line number is WRONG:
${changedLinesSummary}`;

  const userPrompt = `PR: "${prTitle}"
Files changed: ${fileList}
${backlogContext}
${diffBlock}`;

  // Check neuron budget before calling AI
  const budget = await checkNeuronBudget(env, "Review");
  if (!budget.allowed) {
    console.log(`(log) [Review] Neuron budget exhausted (${budget.used}/${NEURON_DAILY_LIMIT}), skipping AI review`);
    return fileChanges.map(fc => ({
      file: fc.path,
      line: fc.changedLines?.[0] || 1,
      comment: "⚠️ AI review skipped — daily neuron budget exhausted. Manual review recommended.",
    }));
  }

  const aiResponse = await env.AI.run(CF_AI_MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 1024,
  });

  const rawResponse = aiResponse?.response;
  const rawReview = typeof rawResponse === "string"
    ? rawResponse
    : JSON.stringify(rawResponse, null, 2);
  console.log("(log) [Review] AI batch response:", rawReview?.substring(0, 200));

  // Record neuron usage
  const inputChars = systemPrompt.length + userPrompt.length;
  const outputChars = rawReview?.length || 0;
  await recordNeuronUsage(env, inputChars, outputChars, "Review");

  // Parse AI response into comments array
  try {
    let comments;
    if (Array.isArray(rawResponse)) {
      comments = rawResponse;
    } else if (typeof rawResponse === "string") {
      // Use greedy match to capture the entire JSON array (including nested arrays)
      const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
      comments = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } else {
      comments = [];
    }
    if (!Array.isArray(comments)) comments = [];
    // Deduplicate: keep only the first comment per file+line
    if (comments.length > 0) {
      const seen = new Set();
      comments = comments.filter((c) => {
        const key = `${c.file}:${c.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    // Validate: reject comments on lines that aren't actually changed
    const validLinesByFile = new Map();
    for (const fc of fileChanges) {
      validLinesByFile.set(fc.path, new Set(fc.changedLines));
    }
    const beforeCount = comments.length;
    comments = comments.filter((c) => {
      if (!c.file || !c.line) return false;
      const validLines = validLinesByFile.get(c.file);
      if (!validLines) {
        console.log(`(log) [Review] Rejected comment: file "${c.file}" not in batch`);
        return false;
      }
      const lineNum = parseInt(c.line, 10);
      if (!validLines.has(lineNum)) {
        console.log(`(log) [Review] Rejected comment: line ${lineNum} not a changed line in "${c.file}" (valid: ${[...validLines].slice(0, 5).join(",")}...)`);
        return false;
      }
      return true;
    });
    if (beforeCount !== comments.length) {
      console.log(`(log) [Review] Filtered ${beforeCount - comments.length} invalid comments (wrong line numbers)`);
    }
    return comments;
  } catch (e) {
    console.error("(log) [Review] AI JSON parse failed for batch:", e.message);
    return [];
  }
}

// ─── Batch Helper: Self-call via Service Binding ─────────────────────────────
// Uses env.SELF (service binding to itself) to avoid counting as a subrequest.
// Falls back to public fetch if the binding isn't configured.

async function selfCall(batchPayload, env) {
  console.log(`(log) [Review] Self-calling for batch #${batchPayload.batchNumber}, ${batchPayload.remainingFiles.length} files remaining`);

  // Extract token from payload — send via header, not body, for self-calls
  const azureToken = batchPayload.azureToken;
  const payloadWithoutToken = { ...batchPayload };
  delete payloadWithoutToken.azureToken;

  const headers = {
    "Content-Type": "application/json",
    "X-Azure-Token": azureToken,
  };
  const body = JSON.stringify(payloadWithoutToken);

  try {
    let res;
    if (env?.SELF) {
      // Preferred: service binding (free, no subrequest, internal)
      res = await env.SELF.fetch("https://self/", { method: "POST", headers, body });
    } else {
      // Fallback: public URL (counts as subrequest)
      const requestUrl = batchPayload.requestUrl;
      if (!requestUrl) {
        console.error("(log) [Review] No SELF binding and no requestUrl, cannot self-call");
        return false;
      }
      // Re-add token to body for fallback path
      res = await fetchWithTimeout(requestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batchPayload),
      });
    }

    if (!res.ok) {
      console.error(`(log) [Review] Self-call failed: ${res.status} ${await res.text()}`);
      return false;
    }
    console.log("(log) [Review] Self-call accepted:", res.status);
    return true;
  } catch (e) {
    console.error("(log) [Review] Self-call error:", e.message);
    return false;
  }
}

// ─── Post Unified Review Comment ────────────────────────────────────────────

async function postUnifiedReview({
  project, repoId, prId, prTitle,
  allFileChanges, allComments,
  workItems, totalFiles, skippedFiles,
  batchCount, azureHeaders: headers, env, backlogContext,
}) {
  const ORG = orgUrl(env);
  console.log(`(log) [Review] Posting unified review for PR ${prId} (${allFileChanges.length} files, ${allComments.length} comments, ${batchCount} batches)`);

  // Calculate risk
  const totalChangedLines = allFileChanges.reduce((sum, fc) => sum + (fc.changedLines?.length || 0), 0);
  const riskScore = calculateRisk(allFileChanges, totalChangedLines);
  const risk = riskLevel(riskScore);

  // Find largest files
  const largestFiles = allFileChanges
    .sort((a, b) => (b.diff?.length || 0) - (a.diff?.length || 0))
    .slice(0, 3)
    .filter(f => f.diff?.length > 500)
    .map(f => f.path);

  // Generate PR summary for large PRs (uses cheaper model to save neurons)
  let prSummary = "";
  if (allFileChanges.length >= 5 || totalChangedLines > 100) {
    const summaryBudget = await checkNeuronBudget(env, "Review");
    if (!summaryBudget.allowed) {
      console.log("(log) [Review] Skipping PR summary — neuron budget exhausted");
    } else {
      try {
        const summarySystemPrompt = "You are a concise technical writer. Summarize code changes in 2-3 sentences.";
        const summaryPrompt = `Summarize the following PR changes in 2-3 sentences. Focus on what the PR does, not individual files.
PR Title: "${prTitle}"
Files changed: ${allFileChanges.map(f => f.path).join(", ")}
${backlogContext || ""}`;

        const summaryRes = await env.AI.run(CF_AI_MODEL_CHEAP, {
          messages: [
            { role: "system", content: summarySystemPrompt },
            { role: "user", content: summaryPrompt },
          ],
          max_tokens: 256,
        });
        prSummary = summaryRes?.response || "";

        // Record neurons (cheaper model uses ~1/4 the neurons)
        const summaryInputChars = summarySystemPrompt.length + summaryPrompt.length;
        const summaryOutputChars = prSummary.length;
        await recordNeuronUsage(env, summaryInputChars / 4, summaryOutputChars / 4, "Review");
      } catch (e) {
        console.error("(log) [Review] PR summary failed:", e.message);
      }
    }
  }

  // Build summary
  const summary = [`## 🤖 AI Code Review`, ``];

  // Batch info
  summary.push(
    `📊 **Reviewed ${allFileChanges.length} of ${totalFiles} files** (${skippedFiles} skipped as non-reviewable)`,
    batchCount > 1 ? `🔄 Processed in **${batchCount} batches**` : ``,
    ``
  );

  if (prSummary) {
    summary.push(`### 📋 PR Summary`, ``, prSummary, ``);
  }

  summary.push(
    `### ⚠ Risk Analysis`,
    ``,
    `Score: **${riskScore}/100**`,
    `Level: **${risk}**`,
    ``
  );

  if (largestFiles.length > 0) {
    summary.push(`### Largest Changes`, ``);
    for (const f of largestFiles) {
      const fileName = f.split("/").pop();
      summary.push(`* ${fileName}`);
    }
    summary.push(``);
  }

  // ── Secret/Credential Detection (pure regex, zero cost) ──────────────
  const secretFindings = scanForSecrets(allFileChanges);
  if (secretFindings.length > 0) {
    summary.push(`### \u{1F512} Security Alerts`, ``);
    for (const f of secretFindings) {
      const fileName = f.file.split("/").pop();
      summary.push(`- **${f.pattern}** found in \`${fileName}\` at line ${f.line}`);
    }
    summary.push(``);
  }

  if (workItems.length > 0) {
    summary.push(`### 📋 Linked Work Items`, ``);
    for (const wi of workItems) {
      summary.push(`* **${wi.type} #${wi.id}:** ${wi.title} (${wi.state})`);
      if (wi.parent) {
        summary.push(`  * ↳ Parent: **${wi.parent.type} #${wi.parent.id}:** ${wi.parent.title}`);
      }
    }
    summary.push(``);
  }

  // Per-file results from all batches
  if (allComments.length > 0) {
    const byFile = {};
    for (const c of allComments) {
      if (!c.file || !c.comment) continue;
      if (!byFile[c.file]) byFile[c.file] = [];
      byFile[c.file].push(c);
    }

    let hasIssues = false;
    for (const fc of allFileChanges) {
      const fileComments = byFile[fc.path] || [];
      const fileName = fc.path.split("/").pop();
      const isLgtm = fileComments.length > 0 && fileComments.every((c) => c.comment?.toLowerCase().includes("lgtm"));

      if (fileComments.length === 0 || isLgtm) {
        summary.push(`### ✅ \`${fileName}\``, `No issues found.`, ``);
      } else {
        hasIssues = true;
        summary.push(`### 📝 \`${fileName}\``);
        for (const c of fileComments) {
          if (c.comment?.toLowerCase().includes("lgtm")) continue;
          const line = parseInt(c.line, 10);
          summary.push(`- **Line ${line}:** ${c.comment}`);
        }
        summary.push(``);
      }
    }

    if (!hasIssues) {
      summary.push(`---`, `✅ **All changes look good!**`);
    }
  } else {
    summary.push(`✅ **No issues found.** Code looks good!`);
  }

  // Post the review
  const threadBaseUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=${AZURE_API_VERSION}`;
  const summaryBody = {
    comments: [
      {
        parentCommentId: 0,
        content: summary.join("\n"),
        commentType: 1,
      },
    ],
    status: 4,
  };

  const summaryRes = await fetchWithTimeout(threadBaseUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(summaryBody),
  });

  if (summaryRes.ok) {
    console.log("(log) [Review] ✓ Unified review posted");
  } else {
    console.error("(log) [Review] ✗ Post failed:", summaryRes.status, await summaryRes.text());
  }
}

// ─── Initial Batch Processing (from Gateway) ────────────────────────────────

async function processInitialBatch(payload, env) {
  try {
    const {
      pr, batchFiles, remainingFiles,
      backlogContext, workItems,
      totalFiles, skippedFiles, azureToken,
    } = payload;

    console.log(`(log) [Review] Processing initial batch for PR ${pr.id}: "${pr.title}"`);
    console.log(`(log) [Review] Source: ${pr.sourceCommit} | Target: ${pr.targetCommit}`);

    const headers = {
      Authorization: `Basic ${btoa(":" + azureToken)}`,
    };

    console.log(`(log) [Review] Batch 0: processing ${batchFiles.length} files, ${remainingFiles.length} remaining`);

    // 1. Fetch content + compute diffs (1 + N subrequests)
    const { fileChanges } = await fetchAndDiffFiles(
      batchFiles, pr.project, pr.repoId, pr.sourceCommit, pr.targetCommit, headers, env
    );

    // 2. AI review for this batch (1 subrequest)
    const batchComments = await aiReviewBatch(fileChanges, pr.title, backlogContext, env);

    // 3. If remaining files → self-call to continue; else post final review
    if (remainingFiles.length > 0) {
      const batchPayload = {
        __isBatchContinuation: true,
        pr,
        backlogContext,
        workItems,
        remainingFiles,
        accumulatedResults: { fileChanges, comments: batchComments },
        batchNumber: 1,
        totalFiles,
        skippedFiles,
        azureToken,
      };

      const success = await selfCall(batchPayload, env);
      if (!success) {
        // Self-call failed — retry once
        console.log("(log) [Review] Retrying self-call...");
        const retrySuccess = await selfCall(batchPayload, env);
        if (!retrySuccess) {
          // Post partial review with what we have
          console.log("(log) [Review] Self-call retry failed, posting partial review");
          await postUnifiedReview({
            project: pr.project, repoId: pr.repoId, prId: pr.id, prTitle: pr.title,
            allFileChanges: fileChanges,
            allComments: batchComments,
            workItems: workItems || [],
            totalFiles,
            skippedFiles: skippedFiles + remainingFiles.length,
            batchCount: 1,
            azureHeaders: headers, env, backlogContext,
          });
        }
      }
    } else {
      // Single batch — post final review directly
      await postUnifiedReview({
        project: pr.project, repoId: pr.repoId, prId: pr.id, prTitle: pr.title,
        allFileChanges: fileChanges,
        allComments: batchComments,
        workItems: workItems || [],
        totalFiles,
        skippedFiles,
        batchCount: 1,
        azureHeaders: headers, env, backlogContext,
      });
    }

    console.log(`(log) [Review] Batch 0 done for PR ${pr.id}`);
  } catch (err) {
    console.error("(log) [Review] Error in processInitialBatch:", err.stack || err);
  }
}

// ─── Batch N Processing (self-call continuation) ────────────────────────────

async function processBatch(payload, env) {
  try {
    const {
      pr, backlogContext, workItems, remainingFiles,
      accumulatedResults, batchNumber, totalFiles, skippedFiles,
      azureToken,
    } = payload;

    // Safety: prevent infinite loops
    if (batchNumber > MAX_BATCHES) {
      console.error(`(log) [Review] Exceeded MAX_BATCHES (${MAX_BATCHES}), posting partial review`);
      const headers = { Authorization: `Basic ${btoa(":" + azureToken)}` };
      await postUnifiedReview({
        project: pr.project, repoId: pr.repoId, prId: pr.id, prTitle: pr.title,
        allFileChanges: accumulatedResults.fileChanges,
        allComments: accumulatedResults.comments,
        workItems: workItems || [],
        totalFiles,
        skippedFiles: skippedFiles + remainingFiles.length,
        batchCount: batchNumber,
        azureHeaders: headers, env, backlogContext,
      });
      return;
    }

    // Safety: verify remaining files is decreasing
    if (remainingFiles.length === 0) {
      console.log("(log) [Review] No remaining files, posting final review");
      const headers = { Authorization: `Basic ${btoa(":" + azureToken)}` };
      await postUnifiedReview({
        project: pr.project, repoId: pr.repoId, prId: pr.id, prTitle: pr.title,
        allFileChanges: accumulatedResults.fileChanges,
        allComments: accumulatedResults.comments,
        workItems: workItems || [],
        totalFiles,
        skippedFiles,
        batchCount: batchNumber,
        azureHeaders: headers, env, backlogContext,
      });
      return;
    }

    const headers = { Authorization: `Basic ${btoa(":" + azureToken)}` };

    // Batch N can take 22 files (no overhead subrequests needed)
    const BATCH_N_SIZE = MAX_BATCH_FILES + 2;
    const batchFiles = remainingFiles.slice(0, BATCH_N_SIZE);
    const nextRemaining = remainingFiles.slice(BATCH_N_SIZE);

    console.log(`(log) [Review] Batch ${batchNumber}: processing ${batchFiles.length} files, ${nextRemaining.length} remaining`);

    // Fetch content + compute diffs
    const { fileChanges } = await fetchAndDiffFiles(
      batchFiles, pr.project, pr.repoId, pr.sourceCommit, pr.targetCommit, headers, env
    );

    // AI review for this batch (1 subrequest)
    let batchComments = [];
    try {
      batchComments = await aiReviewBatch(fileChanges, pr.title, backlogContext, env);
    } catch (e) {
      console.error(`(log) [Review] AI failed for batch ${batchNumber}:`, e.message);
      // Mark files as not reviewed but continue chain
      for (const fc of fileChanges) {
        batchComments.push({ file: fc.path, line: 1, comment: "⚠️ Could not review this file (AI error in batch)" });
      }
    }

    // Merge results
    const mergedResults = {
      fileChanges: [...accumulatedResults.fileChanges, ...fileChanges],
      comments: [...accumulatedResults.comments, ...batchComments],
    };

    if (nextRemaining.length > 0) {
      // More files to process — self-call
      const nextPayload = {
        __isBatchContinuation: true,
        pr,
        backlogContext,
        workItems,
        remainingFiles: nextRemaining,
        accumulatedResults: mergedResults,
        batchNumber: batchNumber + 1,
        totalFiles,
        skippedFiles,
        azureToken,
      };

      const success = await selfCall(nextPayload, env);
      if (!success) {
        console.log("(log) [Review] Self-call failed, retrying...");
        const retrySuccess = await selfCall(nextPayload, env);
        if (!retrySuccess) {
          console.log("(log) [Review] Retry failed, posting partial review");
          await postUnifiedReview({
            project: pr.project, repoId: pr.repoId, prId: pr.id, prTitle: pr.title,
            allFileChanges: mergedResults.fileChanges,
            allComments: mergedResults.comments,
            workItems: workItems || [],
            totalFiles,
            skippedFiles: skippedFiles + nextRemaining.length,
            batchCount: batchNumber + 1,
            azureHeaders: headers, env, backlogContext,
          });
        }
      }
    } else {
      // Last batch — post unified review
      console.log(`(log) [Review] Final batch ${batchNumber}, posting unified review`);
      await postUnifiedReview({
        project: pr.project, repoId: pr.repoId, prId: pr.id, prTitle: pr.title,
        allFileChanges: mergedResults.fileChanges,
        allComments: mergedResults.comments,
        workItems: workItems || [],
        totalFiles,
        skippedFiles,
        batchCount: batchNumber + 1,
        azureHeaders: headers, env, backlogContext,
      });
    }

    console.log(`(log) [Review] Batch ${batchNumber} done for PR ${pr.id}`);
  } catch (err) {
    console.error(`(log) [Review] Error in processBatch #${payload.batchNumber}:`, err.stack || err);
    // Try to post partial review with what we have
    try {
      const headers = { Authorization: `Basic ${btoa(":" + payload.azureToken)}` };
      await postUnifiedReview({
        project: payload.pr.project, repoId: payload.pr.repoId,
        prId: payload.pr.id, prTitle: payload.pr.title,
        allFileChanges: payload.accumulatedResults.fileChanges,
        allComments: payload.accumulatedResults.comments,
        workItems: payload.workItems || [],
        totalFiles: payload.totalFiles,
        skippedFiles: payload.skippedFiles + payload.remainingFiles.length,
        batchCount: payload.batchNumber,
        azureHeaders: headers, env, backlogContext: payload.backlogContext,
      });
    } catch (postErr) {
      console.error("(log) [Review] Could not post partial review:", postErr.message);
    }
  }
}

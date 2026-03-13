const ORG = "https://dev.azure.com/bindtuning";
const AZURE_API_VERSION = "7.0";
const AZURE_API_VERSION_FILEDIFFS = "7.1";
const MAX_DIFF_SIZE = 60000;
const MAX_FILE_DIFF = 3000;
const MAX_BACKLOG_SIZE = 3000;
const CONTEXT_LINES = 10;
const MAX_BATCH_FILES = 20;
const MAX_BATCHES = 15;
const CF_AI_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";

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

    console.log("(log) Webhook received");

    // Batch continuation routing — self-calls from previous batch
    if (payload.__isBatchContinuation) {
      console.log(`(log) Batch continuation #${payload.batchNumber} received`);
      ctx.waitUntil(processBatch(payload, env, request));
      return new Response("Batch accepted", { status: 202 });
    }

    if (!payload?.resource?.pullRequestId) {
      console.log("(log) No pull request ID found");
      return new Response("No PR", { status: 200 });
    }

    ctx.waitUntil(processReview(payload, env, request));
    return new Response("Accepted", { status: 202 });
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchFileAtCommit(project, repoId, path, commitId, headers) {
  const url = `${ORG}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(
    path
  )}&versionDescriptor.version=${commitId}&versionDescriptor.versionType=commit&includeContent=true&api-version=${AZURE_API_VERSION}`;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return res.text();
}

// ─── Backlog / Work Items ────────────────────────────────────────────────────

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Fetch work items linked to a PR, then walk up to parent user stories.
 * Returns an array of { id, type, title, description, acceptanceCriteria, parent? }.
 */
async function fetchLinkedWorkItems(project, repoId, prId, headers) {
  try {
    // 1. Get work item refs linked to the PR
    const refsUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/workitems?api-version=${AZURE_API_VERSION}`;
    const refsRes = await fetch(refsUrl, { headers });
    if (!refsRes.ok) {
      console.log("(log) Could not fetch PR work item refs:", refsRes.status);
      return [];
    }
    const refsData = await refsRes.json();
    const refs = refsData.value || [];
    if (refs.length === 0) return [];

    // 2. Batch-fetch full work item details (with relations so we can find parents)
    const ids = refs.map((r) => r.id).join(",");
    const wiUrl = `${ORG}/${project}/_apis/wit/workitems?ids=${ids}&$expand=relations&api-version=${AZURE_API_VERSION}`;
    const wiRes = await fetch(wiUrl, { headers });
    if (!wiRes.ok) {
      console.log("(log) Could not fetch work item details:", wiRes.status);
      return [];
    }
    const wiData = await wiRes.json();
    const workItems = (wiData.value || []).map((wi) => ({
      id: wi.id,
      type: wi.fields["System.WorkItemType"],
      title: wi.fields["System.Title"],
      state: wi.fields["System.State"],
      description: stripHtml(wi.fields["System.Description"]),
      acceptanceCriteria: stripHtml(
        wi.fields["Microsoft.VSAT.Common.AcceptanceCriteria"] || ""
      ),
      tags: wi.fields["System.Tags"] || "",
      _relations: wi.relations || [],
    }));

    // 3. For tasks/bugs, try to fetch the parent user story / feature
    const parentIds = new Set();
    for (const wi of workItems) {
      const parentRel = wi._relations.find(
        (r) => r.rel === "System.LinkTypes.Hierarchy-Reverse"
      );
      if (parentRel) {
        const parentId = parentRel.url.split("/").pop();
        if (!refs.some((r) => String(r.id) === parentId)) {
          parentIds.add(parentId);
        }
      }
    }

    let parentMap = {};
    if (parentIds.size > 0) {
      const parentIdsStr = [...parentIds].join(",");
      const parentUrl = `${ORG}/${project}/_apis/wit/workitems?ids=${parentIdsStr}&api-version=${AZURE_API_VERSION}`;
      const parentRes = await fetch(parentUrl, { headers });
      if (parentRes.ok) {
        const parentData = await parentRes.json();
        for (const pw of parentData.value || []) {
          parentMap[pw.id] = {
            id: pw.id,
            type: pw.fields["System.WorkItemType"],
            title: pw.fields["System.Title"],
            description: stripHtml(pw.fields["System.Description"]),
            acceptanceCriteria: stripHtml(
              pw.fields["Microsoft.VSAT.Common.AcceptanceCriteria"] || ""
            ),
          };
        }
      }
    }

    // 4. Attach parent info and clean up internal fields
    return workItems.map((wi) => {
      const parentRel = wi._relations.find(
        (r) => r.rel === "System.LinkTypes.Hierarchy-Reverse"
      );
      const parentId = parentRel ? parentRel.url.split("/").pop() : null;
      const { _relations, ...clean } = wi;
      return {
        ...clean,
        parent: parentId ? parentMap[parentId] || null : null,
      };
    });
  } catch (err) {
    console.error("(log) Error fetching work items:", err.message);
    return [];
  }
}

/**
 * Build a backlog context string from work items, respecting MAX_BACKLOG_SIZE.
 */
function buildBacklogContext(workItems) {
  if (workItems.length === 0) return "";

  let context = "\n## Linked Work Items (Product Backlog)\n";

  for (const wi of workItems) {
    let section = `\n### ${wi.type} #${wi.id}: ${wi.title}`;
    section += `\nState: ${wi.state}`;
    if (wi.tags) section += ` | Tags: ${wi.tags}`;
    section += "\n";

    if (wi.description) {
      section += `**Description:** ${wi.description.substring(0, 500)}\n`;
    }
    if (wi.acceptanceCriteria) {
      section += `**Acceptance Criteria:** ${wi.acceptanceCriteria.substring(0, 500)}\n`;
    }

    // Include parent user story if available
    if (wi.parent) {
      section += `\n> **Parent ${wi.parent.type} #${wi.parent.id}:** ${wi.parent.title}\n`;
      if (wi.parent.acceptanceCriteria) {
        section += `> **Parent Acceptance Criteria:** ${wi.parent.acceptanceCriteria.substring(0, 400)}\n`;
      }
    }

    if (context.length + section.length > MAX_BACKLOG_SIZE) {
      console.log("(log) Backlog budget reached, skipping remaining items");
      break;
    }
    context += section;
  }

  return context;
}

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
  const n = aEnd - aStart;
  const m = bEnd - bStart;

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
function computeDiff(oldText, newText) {
  const oldLines = (oldText || "").split("\n");
  const newLines = (newText || "").split("\n");

  const ops = myersDiff(oldLines, newLines);

  // Only keep non-equal ops (the actual changes)
  const changes = ops.filter(op => op.op !== "equal");
  if (changes.length === 0) return { diff: "", changedLines: [] };

  // Group changes into hunks with context
  // First, build the full list with indices to identify hunk boundaries
  const changeIndices = []; // index into ops array where changes occur
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
  const changedLines = []; // new file line numbers of changed/added lines

  for (const hunk of hunks) {
    // Find context boundaries
    const ctxStart = Math.max(0, hunk.start - CONTEXT_LINES);
    const ctxEnd = Math.min(ops.length - 1, hunk.end + CONTEXT_LINES);

    // Determine the starting new-file line number for the @@ header
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

// ─── File Classifier (zero subrequests — path-only) ─────────────────────────

const SKIP_PATTERNS = [
  // ── Lock files & package managers ──
  /package-lock\.json$/i, /yarn\.lock$/i, /pnpm-lock\.yaml$/i,
  // ── C# generated / build artifacts ──
  /\.designer\.cs$/i, /\.g\.cs$/i, /\.g\.i\.cs$/i, /\.generated\.cs$/i,
  /AssemblyInfo\.cs$/i,
  /\.csproj$/i, /\.sln$/i, /\.suo$/i, /\.user$/i,
  /\/bin\//, /\/obj\//,
  /\/migrations\//i, /\.migration\.cs$/i,
  /\.resx$/i, /\.xaml$/i,
  /appsettings(\.\w+)?\.json$/i, /launchSettings\.json$/i,
  // ── JS/TS build output & minified ──
  /\.min\.js$/i, /\.min\.css$/i, /\.bundle\.js$/i,
  /\/dist\//, /\/node_modules\//, /\/lib\//, /\/coverage\//,
  // ── Angular noise ──
  /angular\.json$/i, /karma\.conf\.js$/i, /protractor\.conf\.js$/i,
  /polyfills\.ts$/i, /environment\.(prod|dev|staging)\.ts$/i,
  /\.browserslistrc$/i,
  // ── SPFx noise ──
  /\.manifest\.json$/i, /\.yo-rc\.json$/i,
  /\/config\/(config|deploy-azure-storage|package-solution|serve|write-manifests)\.json$/i,
  /gulpfile\.js$/i,
  /\/loc\/[^/]+\.(d\.ts|js)$/i,
  // ── Binary / media / fonts ──
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp4|mp3|zip|pdf|webp)$/i,
  // ── Docs, config boilerplate ──
  /\.md$/i, /\.txt$/i, /LICENSE/i, /\.gitignore$/i, /\.gitattributes$/i,
  /\.editorconfig$/i, /\.prettierrc/i, /\.eslintrc/i, /tsconfig.*\.json$/i,
  /\.dockerignore$/i, /Dockerfile$/i, /docker-compose/i,
  /tslint\.json$/i, /\.npmignore$/i,
];

const HIGH_EXTENSIONS = /\.(cs|ts|tsx|js|jsx|py|go|rs|java|kt|rb|swift|vue|svelte)$/i;
const LOW_EXTENSIONS = /\.(test\.|spec\.|tests\.|_test\.|_spec\.)/i;
const LOW_PATHS = /\/(tests?|__tests__|specs?|testing|stylesheets?|styles|e2e)\//i;
const LOW_FILE_EXTENSIONS = /\.(css|scss|sass|less)$/i;

// Angular component templates have real logic — treat as HIGH, not LOW
const ANGULAR_TEMPLATE = /\.component\.html$/i;

const PRIORITY_KEYWORDS = [
  // ── C# backend ──
  { pattern: /(controller|handler|endpoint)/i, score: 10 },
  { pattern: /(service|repository|provider|manager)/i, score: 8 },
  { pattern: /(middleware|filter|interceptor|guard|attribute)/i, score: 7 },
  { pattern: /(startup|program)\.cs$/i, score: 7 },
  { pattern: /(model|entity|schema|dto|viewmodel)/i, score: 5 },
  // ── Angular ──
  { pattern: /\.component\.ts$/i, score: 9 },
  { pattern: /\.service\.ts$/i, score: 8 },
  { pattern: /\.guard\.ts$/i, score: 7 },
  { pattern: /\.interceptor\.ts$/i, score: 7 },
  { pattern: /\.resolver\.ts$/i, score: 7 },
  { pattern: /\.directive\.ts$/i, score: 6 },
  { pattern: /\.pipe\.ts$/i, score: 5 },
  { pattern: /\.module\.ts$/i, score: 4 },
  { pattern: /\.component\.html$/i, score: 6 },
  // ── SPFx ──
  { pattern: /WebPart\.ts$/i, score: 9 },
  { pattern: /\.extension\.ts$/i, score: 8 },
  { pattern: /\.command\.ts$/i, score: 8 },
  // ── General ──
  { pattern: /(api|route)/i, score: 9 },
  { pattern: /(util|helper|extension|config)/i, score: 3 },
];

/**
 * Classify all files by path alone (zero subrequests).
 * Returns { skip: [...], high: [...], low: [...] }
 * High files are sorted by priority score (highest first).
 */
function classifyFiles(entries) {
  const skip = [];
  const high = [];
  const low = [];

  for (const c of entries) {
    const path = c.item?.path;
    const changeType = c.changeType;

    if (!path || path.endsWith("/")) continue;

    const ct = typeof changeType === "string" ? changeType.toLowerCase() : changeType;
    const isEdit = ct === "edit" || ct === 2;
    const isAdd = ct === "add" || ct === 1;
    if (!isEdit && !isAdd) continue;

    const fileInfo = { path, changeType: ct, isEdit, isAdd, changeTrackingId: c.changeTrackingId };

    // Check SKIP patterns
    if (SKIP_PATTERNS.some((re) => re.test(path))) {
      skip.push(fileInfo);
      continue;
    }

    // Angular component templates have real logic — treat as HIGH
    if (ANGULAR_TEMPLATE.test(path)) {
      let priorityScore = 6;
      for (const kw of PRIORITY_KEYWORDS) {
        if (kw.pattern.test(path)) {
          priorityScore = Math.max(priorityScore, kw.score);
        }
      }
      fileInfo.priorityScore = priorityScore;
      high.push(fileInfo);
      continue;
    }

    // Check LOW patterns (tests, styles, etc.)
    if (LOW_EXTENSIONS.test(path) || LOW_PATHS.test(path) || LOW_FILE_EXTENSIONS.test(path)) {
      low.push(fileInfo);
      continue;
    }

    // Check HIGH extensions
    if (HIGH_EXTENSIONS.test(path)) {
      // Calculate priority score
      let priorityScore = 1;
      for (const kw of PRIORITY_KEYWORDS) {
        if (kw.pattern.test(path)) {
          priorityScore = Math.max(priorityScore, kw.score);
        }
      }
      fileInfo.priorityScore = priorityScore;
      high.push(fileInfo);
      continue;
    }

    // Default: treat as low priority
    low.push(fileInfo);
  }

  // Sort HIGH files: highest priority first
  high.sort((a, b) => b.priorityScore - a.priorityScore);

  return { skip, high, low };
}

// ─── Risk Scoring (original) ─────────────────────────────────────────────────

function calculateRisk(fileChanges, totalChangedLines) {
  let score = 0;
  score += fileChanges.length * 2;
  score += Math.floor(totalChangedLines / 10);
  for (const fc of fileChanges) {
    if (fc.diff.length > 1500) score += 3;
  }
  return Math.min(score, 100);
}

function riskLevel(score) {
  if (score < 15) return "LOW";
  if (score < 35) return "MEDIUM";
  return "HIGH";
}

// ─── Main Review Logic ──────────────────────────────────────────────────────

// ─── Batch Helper: Truncate diff at hunk boundary ──────────────────────────

/**
 * Truncate a diff string at a clean hunk boundary (at a "---" separator)
 * instead of cutting mid-line, which confuses the AI.
 */
function truncateDiffAtHunkBoundary(diff, maxLen) {
  if (diff.length <= maxLen) return diff;

  // Find the last "---" hunk separator before the limit
  const truncated = diff.substring(0, maxLen);
  const lastHunkEnd = truncated.lastIndexOf("\n---\n");

  if (lastHunkEnd > 0) {
    return truncated.substring(0, lastHunkEnd + 4); // include the "---\n"
  }

  // No clean boundary found — find last newline at least
  const lastNewline = truncated.lastIndexOf("\n");
  return lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated;
}

// ─── Batch Helper: Fetch + Diff a batch of files ────────────────────────────

/**
 * Use Azure DevOps File Diffs API to get exact changed line ranges,
 * then fetch the new file content and extract only the changed hunks.
 * This replaces our custom diff algorithm with Azure's server-side diff.
 *
 * Subrequests per batch:
 *  - 1 POST to filediffs API (returns line ranges for ALL files in the batch)
 *  - 1 GET per file to fetch new content
 *  = 1 + N subrequests (down from 2N with the old approach)
 */
async function fetchAndDiffFiles(files, project, repoId, sourceCommit, targetCommit, azureHeaders) {
  const fileChanges = [];
  let totalChangedLines = 0;

  // 1. Get line-level diffs from Azure for all files in the batch (1 subrequest!)
  const fileDiffParams = files.map((f) => ({ path: f.path, originalPath: f.path }));
  const fileDiffsUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/filediffs?api-version=${AZURE_API_VERSION_FILEDIFFS}`;

  let fileDiffsData = [];
  try {
    const fileDiffsRes = await fetch(fileDiffsUrl, {
      method: "POST",
      headers: { ...azureHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        baseVersionCommit: targetCommit,
        targetVersionCommit: sourceCommit,
        fileDiffParams,
      }),
    });

    if (fileDiffsRes.ok) {
      const data = await fileDiffsRes.json();
      fileDiffsData = data.value || data || [];
      console.log(`(log) File diffs API returned data for ${fileDiffsData.length} files`);
    } else {
      console.error(`(log) File diffs API failed: ${fileDiffsRes.status}`);
    }
  } catch (e) {
    console.error("(log) File diffs API error:", e.message);
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
    console.log(`(log) Processing file (${f.isAdd ? "add" : "edit"}): ${f.path}`);

    const newContent = await fetchFileAtCommit(project, repoId, f.path, sourceCommit, azureHeaders);

    if (newContent === null) {
      console.log("(log) Skipping (could not fetch):", f.path);
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
      console.log(`(log) No diff blocks from Azure for ${f.path}, skipping`);
      continue;
    }

    // Build hunks from Azure's lineDiffBlocks
    // changeType: 0=None, 1=Add, 2=Delete, 3=Edit (we want 1 and 3 for new lines)
    const output = [];
    const changedLines = [];

    for (const block of blocks) {
      if (block.changeType === 0) continue; // no change

      const modStart = block.modifiedLineNumberStart; // 1-based
      const modCount = block.modifiedLinesCount;

      // Context: show a few lines before and after the changed range
      const ctxBefore = Math.max(0, modStart - 1 - CONTEXT_LINES);
      const ctxAfter = Math.min(newLines.length, modStart - 1 + modCount + CONTEXT_LINES);

      output.push(`@@ line ${modStart} @@`);

      for (let i = ctxBefore; i < ctxAfter; i++) {
        const lineNum = i + 1; // 1-based
        const isChanged = lineNum >= modStart && lineNum < modStart + modCount;

        if (isChanged) {
          if (block.changeType === 2) {
            // Pure delete — line exists in old file, not in new
            output.push(`-${lineNum}: (deleted)`);
          } else {
            // Add or Edit — line exists in new file
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
      console.log(`(log) ${f.path}: changed lines [${changedLines.slice(0, 10).join(",")}${changedLines.length > 10 ? "..." : ""}] (${changedLines.length} total)`);
      fileChanges.push({
        path: f.path,
        changeTrackingId: f.changeTrackingId,
        isAdd: false,
        diff: truncateDiffAtHunkBoundary(diff, MAX_FILE_DIFF),
        changedLines,
      });
    } else {
      console.log(`(log) ${f.path}: no modified lines found in diff blocks`);
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
      console.log("(log) Diff budget reached, skipping remaining files in this batch");
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

  console.log(`(log) AI batch review: ${fileChanges.length} files, ${diffBlock.length} chars`);

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
  console.log("(log) AI batch response:", rawReview?.substring(0, 200));

  // Parse AI response into comments array
  try {
    let comments;
    if (Array.isArray(rawResponse)) {
      comments = rawResponse;
    } else if (typeof rawResponse === "string") {
      const jsonMatch = rawResponse.match(/\[[\s\S]*?\]/);
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
        console.log(`(log) Rejected comment: file "${c.file}" not in batch`);
        return false;
      }
      const lineNum = parseInt(c.line, 10);
      if (!validLines.has(lineNum)) {
        console.log(`(log) Rejected comment: line ${lineNum} not a changed line in "${c.file}" (valid: ${[...validLines].slice(0, 5).join(",")}...)`);
        return false;
      }
      return true;
    });
    if (beforeCount !== comments.length) {
      console.log(`(log) Filtered ${beforeCount - comments.length} invalid comments (wrong line numbers)`);
    }
    return comments;
  } catch (e) {
    console.error("(log) AI JSON parse failed for batch:", e.message);
    return [];
  }
}

// ─── Batch Helper: Self-call to continue processing ─────────────────────────

async function selfCall(batchPayload, requestUrl) {
  console.log(`(log) Self-calling for batch #${batchPayload.batchNumber}, ${batchPayload.remainingFiles.length} files remaining`);

  const res = await fetch(requestUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batchPayload),
  });

  if (!res.ok) {
    console.error(`(log) Self-call failed: ${res.status}`);
    return false;
  }
  console.log(`(log) Self-call accepted for batch #${batchPayload.batchNumber}`);
  return true;
}

// ─── Unified Review Posting ─────────────────────────────────────────────────

async function postUnifiedReview({
  project, repoId, prId, prTitle,
  allFileChanges, allComments, workItems,
  totalFiles, skippedFiles, batchCount,
  azureHeaders, env, backlogContext,
}) {
  // Risk analysis across all reviewed files
  const totalChangedLines = allFileChanges.reduce((sum, fc) => sum + fc.changedLines.length, 0);
  const riskScore = calculateRisk(allFileChanges, totalChangedLines);
  const risk = riskLevel(riskScore);
  console.log(`(log) Final risk score: ${riskScore}/100 (${risk})`);

  // Largest file changes (top 3)
  const largestFiles = [...allFileChanges]
    .sort((a, b) => b.diff.length - a.diff.length)
    .slice(0, 3)
    .map((fc) => fc.path);

  // AI PR summary (only for large PRs)
  let prSummary = null;
  const totalDiffSize = allFileChanges.reduce((sum, fc) => sum + fc.diff.length, 0);
  if (totalDiffSize > 5000) {
    console.log("(log) Large PR detected, generating AI summary...");
    try {
      const summaryDiff = buildDiffBlock(allFileChanges).substring(0, 4000);
      const summaryAiResponse = await env.AI.run(CF_AI_MODEL, {
        messages: [
          { role: "system", content: "You summarize pull requests." },
          {
            role: "user",
            content: `Explain this pull request in 3 concise bullet points.\n\nPR title: ${prTitle}\n\nChanges:\n${summaryDiff}`,
          },
        ],
        max_tokens: 200,
      });
      prSummary = summaryAiResponse?.response || null;
    } catch (e) {
      console.error("(log) Summary generation failed:", e.message);
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

  const summaryRes = await fetch(threadBaseUrl, {
    method: "POST",
    headers: { ...azureHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(summaryBody),
  });

  if (summaryRes.ok) {
    console.log("(log) ✓ Unified review posted");
  } else {
    console.error("(log) ✗ Post failed:", summaryRes.status, await summaryRes.text());
  }
}

// ─── Main Review Logic (Batch 0) ────────────────────────────────────────────

async function processReview(payload, env, request) {
  try {
    const prId = payload.resource.pullRequestId;
    const repoId = payload.resource.repository.id;
    const project = payload.resource.repository.project.name;
    const prTitle = payload.resource.title || "";
    const sourceCommit = payload.resource.lastMergeSourceCommit.commitId;
    const targetCommit = payload.resource.lastMergeTargetCommit.commitId;
    const requestUrl = request.url;

    console.log(`(log) Processing PR ${prId}: "${prTitle}"`);
    console.log(`(log) Source: ${sourceCommit} | Target: ${targetCommit}`);

    const azureHeaders = {
      Authorization: `Basic ${btoa(":" + env.AZURE_TOKEN)}`,
    };

    // 1. Get latest iteration (1 subrequest)
    const iterUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations?api-version=${AZURE_API_VERSION}`;
    const iterRes = await fetch(iterUrl, { headers: azureHeaders });
    if (!iterRes.ok) {
      console.error("(log) Failed to fetch iterations:", iterRes.status);
      return;
    }
    const iterData = await iterRes.json();
    const latestIteration = Math.max(...iterData.value.map((i) => i.id));

    // 2. Get changed files (1 subrequest)
    const changesUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations/${latestIteration}/changes?api-version=${AZURE_API_VERSION}`;
    const changesRes = await fetch(changesUrl, { headers: azureHeaders });
    if (!changesRes.ok) {
      console.error("(log) Failed to fetch changes:", changesRes.status);
      return;
    }
    const changesData = await changesRes.json();
    const entries = changesData.changeEntries || changesData.changes || [];

    // 3. Fetch linked work items (~3 subrequests)
    const workItems = await fetchLinkedWorkItems(project, repoId, prId, azureHeaders);
    console.log(`(log) Linked work items: ${workItems.length}`);
    const backlogContext = buildBacklogContext(workItems);

    // 4. Classify all files (zero subrequests!)
    const classified = classifyFiles(entries);
    console.log(`(log) Classification: ${classified.high.length} HIGH, ${classified.low.length} LOW, ${classified.skip.length} SKIP`);

    // Reviewable = HIGH first, then LOW
    const reviewableFiles = [...classified.high, ...classified.low];
    const totalFiles = classified.high.length + classified.low.length + classified.skip.length;
    const skippedFiles = classified.skip.length;

    if (reviewableFiles.length === 0) {
      console.log("(log) No reviewable files found after classification");
      return;
    }

    // 5. Take first batch (MAX_BATCH_FILES files)
    const batchFiles = reviewableFiles.slice(0, MAX_BATCH_FILES);
    const remainingFiles = reviewableFiles.slice(MAX_BATCH_FILES);

    console.log(`(log) Batch 0: processing ${batchFiles.length} files, ${remainingFiles.length} remaining`);

    // 6. Fetch content + compute diffs (2 subrequests per file = ~40)
    const { fileChanges } = await fetchAndDiffFiles(
      batchFiles, project, repoId, sourceCommit, targetCommit, azureHeaders
    );

    // 7. AI review for this batch (1 subrequest)
    const batchComments = await aiReviewBatch(fileChanges, prTitle, backlogContext, env);

    // 8. If remaining files → self-call to continue; else post final review
    if (remainingFiles.length > 0) {
      const batchPayload = {
        __isBatchContinuation: true,
        pr: { id: prId, repoId, project, title: prTitle, sourceCommit, targetCommit },
        backlogContext,
        workItems,
        remainingFiles,
        accumulatedResults: { fileChanges, comments: batchComments },
        batchNumber: 1,
        totalFiles,
        skippedFiles,
        requestUrl,
        azureToken: env.AZURE_TOKEN,
      };

      const success = await selfCall(batchPayload, requestUrl);
      if (!success) {
        // Self-call failed — retry once
        console.log("(log) Retrying self-call...");
        const retrySuccess = await selfCall(batchPayload, requestUrl);
        if (!retrySuccess) {
          // Post partial review with what we have
          console.log("(log) Self-call retry failed, posting partial review");
          await postUnifiedReview({
            project, repoId, prId, prTitle,
            allFileChanges: fileChanges,
            allComments: batchComments,
            workItems,
            totalFiles,
            skippedFiles: skippedFiles + remainingFiles.length,
            batchCount: 1,
            azureHeaders, env, backlogContext,
          });
        }
      }
    } else {
      // Single batch — post final review directly
      await postUnifiedReview({
        project, repoId, prId, prTitle,
        allFileChanges: fileChanges,
        allComments: batchComments,
        workItems,
        totalFiles,
        skippedFiles,
        batchCount: 1,
        azureHeaders, env, backlogContext,
      });
    }

    console.log(`(log) Batch 0 done for PR ${prId}`);
  } catch (err) {
    console.error("(log) Error in processReview:", err.stack || err);
  }
}

// ─── Batch N Processing ─────────────────────────────────────────────────────

async function processBatch(payload, env, request) {
  try {
    const {
      pr, backlogContext, workItems, remainingFiles,
      accumulatedResults, batchNumber, totalFiles, skippedFiles,
      requestUrl, azureToken,
    } = payload;

    // Safety: prevent infinite loops
    if (batchNumber > MAX_BATCHES) {
      console.error(`(log) Exceeded MAX_BATCHES (${MAX_BATCHES}), posting partial review`);
      const azureHeaders = { Authorization: `Basic ${btoa(":" + azureToken)}` };
      await postUnifiedReview({
        project: pr.project, repoId: pr.repoId, prId: pr.id, prTitle: pr.title,
        allFileChanges: accumulatedResults.fileChanges,
        allComments: accumulatedResults.comments,
        workItems: workItems || [],
        totalFiles,
        skippedFiles: skippedFiles + remainingFiles.length,
        batchCount: batchNumber,
        azureHeaders, env, backlogContext,
      });
      return;
    }

    // Safety: verify remaining files is decreasing
    if (remainingFiles.length === 0) {
      console.log("(log) No remaining files, posting final review");
      const azureHeaders = { Authorization: `Basic ${btoa(":" + azureToken)}` };
      await postUnifiedReview({
        project: pr.project, repoId: pr.repoId, prId: pr.id, prTitle: pr.title,
        allFileChanges: accumulatedResults.fileChanges,
        allComments: accumulatedResults.comments,
        workItems: workItems || [],
        totalFiles,
        skippedFiles,
        batchCount: batchNumber,
        azureHeaders, env, backlogContext,
      });
      return;
    }

    const azureHeaders = { Authorization: `Basic ${btoa(":" + azureToken)}` };

    // Batch N can take 22 files (no overhead subrequests needed)
    const BATCH_N_SIZE = MAX_BATCH_FILES + 2;
    const batchFiles = remainingFiles.slice(0, BATCH_N_SIZE);
    const nextRemaining = remainingFiles.slice(BATCH_N_SIZE);

    console.log(`(log) Batch ${batchNumber}: processing ${batchFiles.length} files, ${nextRemaining.length} remaining`);

    // Fetch content + compute diffs (2 subrequests per file)
    const { fileChanges } = await fetchAndDiffFiles(
      batchFiles, pr.project, pr.repoId, pr.sourceCommit, pr.targetCommit, azureHeaders
    );

    // AI review for this batch (1 subrequest)
    let batchComments = [];
    try {
      batchComments = await aiReviewBatch(fileChanges, pr.title, backlogContext, env);
    } catch (e) {
      console.error(`(log) AI failed for batch ${batchNumber}:`, e.message);
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
        requestUrl,
        azureToken,
      };

      const success = await selfCall(nextPayload, requestUrl);
      if (!success) {
        console.log("(log) Self-call failed, retrying...");
        const retrySuccess = await selfCall(nextPayload, requestUrl);
        if (!retrySuccess) {
          console.log("(log) Retry failed, posting partial review");
          await postUnifiedReview({
            project: pr.project, repoId: pr.repoId, prId: pr.id, prTitle: pr.title,
            allFileChanges: mergedResults.fileChanges,
            allComments: mergedResults.comments,
            workItems: workItems || [],
            totalFiles,
            skippedFiles: skippedFiles + nextRemaining.length,
            batchCount: batchNumber + 1,
            azureHeaders, env, backlogContext,
          });
        }
      }
    } else {
      // Last batch — post unified review
      console.log(`(log) Final batch ${batchNumber}, posting unified review`);
      await postUnifiedReview({
        project: pr.project, repoId: pr.repoId, prId: pr.id, prTitle: pr.title,
        allFileChanges: mergedResults.fileChanges,
        allComments: mergedResults.comments,
        workItems: workItems || [],
        totalFiles,
        skippedFiles,
        batchCount: batchNumber + 1,
        azureHeaders, env, backlogContext,
      });
    }

    console.log(`(log) Batch ${batchNumber} done for PR ${pr.id}`);
  } catch (err) {
    console.error(`(log) Error in processBatch #${payload.batchNumber}:`, err.stack || err);
    // Try to post partial review with what we have
    try {
      const azureHeaders = { Authorization: `Basic ${btoa(":" + payload.azureToken)}` };
      await postUnifiedReview({
        project: payload.pr.project, repoId: payload.pr.repoId,
        prId: payload.pr.id, prTitle: payload.pr.title,
        allFileChanges: payload.accumulatedResults.fileChanges,
        allComments: payload.accumulatedResults.comments,
        workItems: payload.workItems || [],
        totalFiles: payload.totalFiles,
        skippedFiles: payload.skippedFiles + payload.remainingFiles.length,
        batchCount: payload.batchNumber,
        azureHeaders, env, backlogContext: payload.backlogContext,
      });
    } catch (postErr) {
      console.error("(log) Could not post partial review:", postErr.message);
    }
  }
}

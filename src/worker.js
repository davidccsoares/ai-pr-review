import { orgUrl, AZURE_API_VERSION, azureHeaders as buildAzureHeaders } from "./lib/azure.js";
import { fetchWithTimeout } from "./lib/fetch.js";
import { MAX_BATCH_FILES } from "./lib/constants.js";

const MAX_BACKLOG_SIZE = 3000;
const MAX_WEBHOOKS_PER_HOUR = 30;

const STARTUP_TIME = Date.now();

export default {
  async fetch(request, env, ctx) {
    // ── Health endpoint ──────────────────────────────────────────────────
    if (request.method === "GET") {
      return Response.json({
        status: "ok",
        worker: "ai-pr-review-gateway",
        uptime: Math.floor((Date.now() - STARTUP_TIME) / 1000),
      });
    }

    if (request.method !== "POST") {
      return new Response("Only GET and POST allowed", { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    console.log("(log) [Gateway] Webhook received");

    if (!payload?.resource?.pullRequestId) {
      console.log("(log) [Gateway] No pull request ID found");
      return new Response("No PR", { status: 200 });
    }

    // ── Rate Limiting ────────────────────────────────────────────────────
    // Limit webhook processing to MAX_WEBHOOKS_PER_HOUR to protect neuron
    // budget and Azure API quota.
    try {
      if (env?.BOT_KV) {
        const hour = new Date().toISOString().slice(0, 13); // "2026-03-19T14"
        const rateKey = `rate:${hour}`;
        const current = parseInt(await env.BOT_KV.get(rateKey) || "0", 10);
        if (current >= MAX_WEBHOOKS_PER_HOUR) {
          console.log(`(log) [Gateway] Rate limit exceeded (${current}/${MAX_WEBHOOKS_PER_HOUR} this hour)`);
          return new Response("Rate limit exceeded", { status: 429 });
        }
        await env.BOT_KV.put(rateKey, String(current + 1), { expirationTtl: 3600 });
      }
    } catch (e) {
      // Fail-open: if KV fails, proceed normally
      console.log("(log) [Gateway] Rate limit check failed (proceeding anyway):", e.message);
    }

    ctx.waitUntil(processReview(payload, env));
    return new Response("Accepted", { status: 202 });
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

export function stripHtml(html) {
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

// ─── Backlog / Work Items ────────────────────────────────────────────────────

/**
 * Fetch work items linked to a PR, then walk up to parent user stories.
 * Returns an array of { id, type, title, description, acceptanceCriteria, parent? }.
 */
async function fetchLinkedWorkItems(env, project, repoId, prId, headers) {
  const ORG = orgUrl(env);
  try {
    // 1. Get work item refs linked to the PR
    const refsUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/workitems?api-version=${AZURE_API_VERSION}`;
    const refsRes = await fetchWithTimeout(refsUrl, { headers });
    if (!refsRes.ok) {
      console.log("(log) [Gateway] Could not fetch PR work item refs:", refsRes.status);
      return [];
    }
    const refsData = await refsRes.json();
    const refs = refsData.value || [];
    if (refs.length === 0) return [];

    // 2. Batch-fetch full work item details (with relations so we can find parents)
    const ids = refs.map((r) => r.id).join(",");
    const wiUrl = `${ORG}/${project}/_apis/wit/workitems?ids=${ids}&$expand=relations&api-version=${AZURE_API_VERSION}`;
    const wiRes = await fetchWithTimeout(wiUrl, { headers });
    if (!wiRes.ok) {
      console.log("(log) [Gateway] Could not fetch work item details:", wiRes.status);
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
      const parentRes = await fetchWithTimeout(parentUrl, { headers });
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
    console.error("(log) [Gateway] Error fetching work items:", err.message);
    return [];
  }
}

/**
 * Build a backlog context string from work items, respecting MAX_BACKLOG_SIZE.
 */
export function buildBacklogContext(workItems) {
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
      console.log("(log) [Gateway] Backlog budget reached, skipping remaining items");
      break;
    }
    context += section;
  }

  return context;
}

// ─── File Classifier (zero subrequests — path-only) ─────────────────────────

export const SKIP_PATTERNS = [
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

export const PRIORITY_KEYWORDS = [
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
export function classifyFiles(entries) {
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

// ─── PR Auto-Tagging ────────────────────────────────────────────────────────

const BACKEND_PATTERN = /\.(cs|py|go|rs|java|kt|rb)$/i;
const FRONTEND_PATTERN = /\.(ts|tsx|js|jsx|vue|svelte|component\.html)$/i;

/**
 * Compute PR labels based on file classification (zero subrequests — pure logic).
 * Returns an array of label strings.
 */
export function computePrLabels(classified) {
  const labels = [];
  const allReviewable = [...classified.high, ...classified.low];

  // docs-only: every file was skipped (no reviewable files)
  if (allReviewable.length === 0 && classified.skip.length > 0) {
    labels.push("docs-only");
    return labels;
  }

  // large-pr: 15+ reviewable files
  if (allReviewable.length >= 15) {
    labels.push("large-pr");
  }

  // high-risk: 5+ high-priority files
  if (classified.high.length >= 5) {
    labels.push("high-risk");
  }

  // frontend / backend detection
  const hasBackend = allReviewable.some(f => BACKEND_PATTERN.test(f.path));
  const hasFrontend = allReviewable.some(f => FRONTEND_PATTERN.test(f.path));
  if (hasBackend) labels.push("backend");
  if (hasFrontend) labels.push("frontend");

  return labels;
}

/**
 * Apply labels to an Azure DevOps PR.
 * Uses POST to add each label individually (Azure DevOps Labels API).
 * Fire-and-forget — failures are logged but don't block the review.
 */
async function applyPrLabels(env, project, repoId, prId, labels, headers) {
  if (labels.length === 0) return;
  const ORG = orgUrl(env);

  const baseUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/labels?api-version=${AZURE_API_VERSION}`;

  const results = await Promise.allSettled(
    labels.map(label =>
      fetchWithTimeout(baseUrl, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: label }),
      })
    )
  );

  const succeeded = results.filter(r => r.status === "fulfilled" && r.value?.ok).length;
  const failed = results.length - succeeded;
  console.log(`(log) [Gateway] PR labels: ${succeeded} applied, ${failed} failed (${labels.join(", ")})`);
}

// ─── Playwright Eligibility & Delegation ────────────────────────────────────

/**
 * Check whether the PR webhook targets the AdminApp repo's Dev branch.
 * Only those PRs should trigger Playwright test generation.
 */
function isPlaywrightEligible(payload, env) {
  const repoName = payload.resource?.repository?.name;
  const targetBranch = payload.resource?.targetRefName;
  const expectedRepo = env?.PLAYWRIGHT_REPO_NAME || "BindTuning.AdminApp";
  const expectedBranch = env?.PLAYWRIGHT_TARGET_BRANCH || "refs/heads/Dev";
  return repoName === expectedRepo && targetBranch === expectedBranch;
}

/**
 * Fire-and-forget: send PR data to the dedicated Playwright test generation
 * worker via Service Binding. Does NOT count as a subrequest!
 */
function firePlaywrightWorker({ payload, fileChanges, env }) {
  const prId = payload.resource.pullRequestId;
  const repoId = payload.resource.repository.id;
  const project = payload.resource.repository.project.name;
  const prTitle = payload.resource.title || "";

  const body = {
    prId,
    repoId,
    project,
    prTitle,
    fileChanges: fileChanges.map(fc => ({
      path: fc.path,
      diff: fc.diff,
      isAdd: fc.isAdd,
    })),
    azureToken: env.AZURE_TOKEN,
  };

  env.PW_CONTEXT.fetch("https://pw-context/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(res => console.log(`(log) [Gateway] Playwright worker responded: ${res.status}`))
    .catch(e => console.error("(log) [Gateway] Playwright worker call failed:", e.message));
}

// ─── Main Review Logic ──────────────────────────────────────────────────────

async function processReview(payload, env) {
  const prId = payload.resource.pullRequestId;
  const repoId = payload.resource.repository.id;
  const project = payload.resource.repository.project.name;
  const prTitle = payload.resource.title || "";
  const sourceCommit = payload.resource.lastMergeSourceCommit.commitId;
  const targetCommit = payload.resource.lastMergeTargetCommit.commitId;

  try {
    // ── Webhook Deduplication (check only — write AFTER success) ─────────
    try {
      if (env?.BOT_KV) {
        const dedupKey = `dedup:${prId}:${sourceCommit}`;
        const existing = await env.BOT_KV.get(dedupKey);
        if (existing) {
          console.log(`(log) [Gateway] Duplicate webhook for PR ${prId} @ ${sourceCommit}, skipping`);
          return;
        }
        // Don't write yet — we'll write after successful delegation (#12)
      }
    } catch (e) {
      // Fail-open: if KV read fails, proceed normally
      console.log("(log) [Gateway] KV dedup check failed (proceeding anyway):", e.message);
    }

    console.log(`(log) [Gateway] Processing PR ${prId}: "${prTitle}"`);
    console.log(`(log) [Gateway] Source: ${sourceCommit} | Target: ${targetCommit}`);
    const ORG = orgUrl(env);

    const headers = buildAzureHeaders(env.AZURE_TOKEN);

    // 1. Get latest iteration (1 subrequest)
    const iterUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations?api-version=${AZURE_API_VERSION}`;
    const iterRes = await fetchWithTimeout(iterUrl, { headers });
    if (!iterRes.ok) {
      console.error("(log) [Gateway] Failed to fetch iterations:", iterRes.status);
      return;
    }
    const iterData = await iterRes.json();
    const latestIteration = Math.max(...iterData.value.map((i) => i.id));

    // 2. Get changed files (1 subrequest)
    const changesUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations/${latestIteration}/changes?api-version=${AZURE_API_VERSION}`;
    const changesRes = await fetchWithTimeout(changesUrl, { headers });
    if (!changesRes.ok) {
      console.error("(log) [Gateway] Failed to fetch changes:", changesRes.status);
      return;
    }
    const changesData = await changesRes.json();
    const entries = changesData.changeEntries || changesData.changes || [];

    // 3. Fetch linked work items (~3 subrequests)
    const workItems = await fetchLinkedWorkItems(env, project, repoId, prId, headers);
    console.log(`(log) [Gateway] Linked work items: ${workItems.length}`);
    const backlogContext = buildBacklogContext(workItems);

    // 4. Classify all files (zero subrequests!)
    const classified = classifyFiles(entries);
    console.log(`(log) [Gateway] Classification: ${classified.high.length} HIGH, ${classified.low.length} LOW, ${classified.skip.length} SKIP`);

    // 4b. Auto-tag PR with labels based on classification (fire-and-forget)
    const prLabels = computePrLabels(classified);
    if (prLabels.length > 0) {
      applyPrLabels(env, project, repoId, prId, prLabels, headers)
        .catch(e => console.log("(log) [Gateway] Label apply error:", e.message));
    }

    // Reviewable = HIGH first, then LOW
    const reviewableFiles = [...classified.high, ...classified.low];
    const totalFiles = classified.high.length + classified.low.length + classified.skip.length;
    const skippedFiles = classified.skip.length;

    if (reviewableFiles.length === 0) {
      console.log("(log) [Gateway] No reviewable files found after classification");
      return;
    }

    // 5. Split into first batch + remaining
    const batchFiles = reviewableFiles.slice(0, MAX_BATCH_FILES);
    const remainingFiles = reviewableFiles.slice(MAX_BATCH_FILES);

    console.log(`(log) [Gateway] Delegating to review worker: ${batchFiles.length} batch files, ${remainingFiles.length} remaining`);

    // 6. Delegate to review worker via Service Binding (does NOT count as a subrequest!)
    const reviewPayload = {
      __isReviewRequest: true,
      pr: {
        id: prId,
        repoId,
        project,
        title: prTitle,
        sourceCommit,
        targetCommit,
      },
      batchFiles,
      remainingFiles,
      backlogContext,
      workItems,
      totalFiles,
      skippedFiles,
      azureToken: env.AZURE_TOKEN,
    };

    const reviewRes = await env.REVIEW_WORKER.fetch("https://review/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reviewPayload),
    });

    if (reviewRes.ok) {
      console.log(`(log) [Gateway] Review worker accepted: ${reviewRes.status}`);
    } else {
      console.error(`(log) [Gateway] Review worker failed: ${reviewRes.status} ${await reviewRes.text()}`);
    }

    // ── Write dedup key AFTER successful delegation ─────────────────────
    // This ensures that if processing fails, the retry webhook won't be blocked.
    try {
      if (env?.BOT_KV) {
        const dedupKey = `dedup:${prId}:${sourceCommit}`;
        await env.BOT_KV.put(dedupKey, "1", { expirationTtl: 3600 });
      }
    } catch (e) {
      console.log("(log) [Gateway] KV dedup write failed (non-critical):", e.message);
    }

    // 7. Playwright test generation (fire-and-forget to pw-context worker)
    //    We send it in parallel — the review worker handles the review,
    //    the playwright pipeline handles test generation independently.
    if (isPlaywrightEligible(payload, env)) {
      console.log("(log) [Gateway] PR is eligible for Playwright, delegating to pw-context worker");
      // Build minimal fileChanges for Playwright (just paths + change type)
      // The pw-context worker will fetch full content itself
      firePlaywrightWorker({
        payload,
        fileChanges: reviewableFiles.map(f => ({
          path: f.path,
          diff: "",
          isAdd: f.isAdd,
        })),
        env,
      });
    }

    console.log(`(log) [Gateway] Done routing PR ${prId}`);
  } catch (err) {
    console.error("(log) [Gateway] Error in processReview:", err.stack || err);
  }
}

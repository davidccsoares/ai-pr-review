import { orgUrl, azureHeaders, AZURE_API_VERSION, AZURE_API_VERSION_FILEDIFFS, fetchFileAtCommit } from "./lib/azure.js";
import { checkNeuronBudget, recordNeuronUsage, NEURON_DAILY_LIMIT } from "./lib/neurons.js";
import { fetchWithTimeout } from "./lib/fetch.js";
import { fetchWithRetry } from "./lib/fetch.js";
import { computeDiff, truncateDiffAtHunkBoundary, CONTEXT_LINES } from "./lib/diffs.js";
import { scanForSecrets, SECRET_PATTERNS } from "./lib/secrets.js";
import { buildDiffBlock, aiReviewBatch } from "./lib/prompts.js";
import { MAX_BATCH_FILES, CF_AI_MODEL_CHEAP } from "./lib/constants.js";

// Re-export lib functions so existing consumers (tests, other workers) can still
// import them from review-worker.js without changing their import paths.
export { computeDiff, truncateDiffAtHunkBoundary, CONTEXT_LINES } from "./lib/diffs.js";
export { scanForSecrets, SECRET_PATTERNS } from "./lib/secrets.js";

const MAX_FILE_DIFF = 12000;
const MAX_BATCHES = 25;

// TTL for stored review issues — 7 days (covers long-lived PRs)
const REVIEW_ISSUES_TTL = 7 * 24 * 3600;

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

// ─── Re-review Tracking ─────────────────────────────────────────────────────

/**
 * Extract actionable issues from AI review comments.
 * Filters out LGTM/no-issue comments and returns a normalized set.
 * Each issue is keyed by "file::comment-text" (line numbers change between
 * pushes, so we match on the issue description instead).
 *
 * @param {Array<{file: string, line: number, comment: string}>} comments
 * @returns {Array<{file: string, line: number, comment: string, key: string}>}
 */
export function extractIssues(comments) {
  if (!Array.isArray(comments)) return [];
  return comments
    .filter(c => {
      if (!c.file || !c.comment) return false;
      const lower = c.comment.toLowerCase().trim();
      if (lower.includes("lgtm")) return false;
      if (lower.startsWith("⚠️ ai review skipped")) return false;
      return true;
    })
    .map(c => ({
      file: c.file,
      line: c.line,
      comment: c.comment,
      key: `${c.file}::${c.comment.trim().toLowerCase().replace(/\s+/g, " ")}`,
    }));
}

/**
 * Compare current review issues against previous review issues.
 * Matching is done by normalized key (file + comment text).
 * Line numbers are ignored because they shift between pushes.
 *
 * @param {Array<{key: string, file: string, line: number, comment: string}>} previousIssues
 * @param {Array<{key: string, file: string, line: number, comment: string}>} currentIssues
 * @returns {{ resolved: Array, stillOpen: Array, new: Array }}
 */
export function diffReviewIssues(previousIssues, currentIssues) {
  const prevKeys = new Set(previousIssues.map(i => i.key));
  const currKeys = new Set(currentIssues.map(i => i.key));

  const resolved = previousIssues.filter(i => !currKeys.has(i.key));
  const stillOpen = currentIssues.filter(i => prevKeys.has(i.key));
  const brandNew = currentIssues.filter(i => !prevKeys.has(i.key));

  return { resolved, stillOpen, new: brandNew };
}

/**
 * Build a markdown follow-up section comparing this review to the previous one.
 *
 * @param {{ resolved: Array, stillOpen: Array, new: Array }} diff
 * @param {number} reviewNumber - Which review iteration this is (2, 3, …)
 * @returns {string} Markdown block to prepend to the review comment
 */
export function buildFollowUpSection(diff, reviewNumber) {
  const lines = [
    `### 🔄 Follow-up Review (iteration #${reviewNumber})`,
    ``,
  ];

  if (diff.resolved.length > 0) {
    lines.push(`**✅ ${diff.resolved.length} issue${diff.resolved.length !== 1 ? "s" : ""} resolved** since last review:`);
    for (const issue of diff.resolved) {
      const fileName = issue.file.split("/").pop();
      lines.push(`- ~\`${fileName}\` line ${issue.line}: ${issue.comment}~`);
    }
    lines.push(``);
  }

  if (diff.stillOpen.length > 0) {
    lines.push(`**⚠️ ${diff.stillOpen.length} issue${diff.stillOpen.length !== 1 ? "s" : ""} still open:**`);
    for (const issue of diff.stillOpen) {
      const fileName = issue.file.split("/").pop();
      lines.push(`- \`${fileName}\` line ${issue.line}: ${issue.comment}`);
    }
    lines.push(``);
  }

  if (diff.new.length > 0) {
    lines.push(`**🆕 ${diff.new.length} new issue${diff.new.length !== 1 ? "s" : ""} found:**`);
    for (const issue of diff.new) {
      const fileName = issue.file.split("/").pop();
      lines.push(`- \`${fileName}\` line ${issue.line}: ${issue.comment}`);
    }
    lines.push(``);
  }

  if (diff.resolved.length > 0 && diff.stillOpen.length === 0 && diff.new.length === 0) {
    lines.push(`🎉 **All previous issues have been addressed!**`, ``);
  }

  lines.push(`---`, ``);
  return lines.join("\n");
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
    const fileDiffsRes = await fetchWithRetry(fileDiffsUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        baseVersionCommit: targetCommit,
        targetVersionCommit: sourceCommit,
        fileDiffParams,
      }),
      timeout: 15_000,
      retries: 3,
      tag: "Review",
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

  // 2. Fetch all file contents in parallel, then build diffs
  console.log(`(log) [Review] Fetching ${files.length} file contents in parallel`);
  const contentResults = await Promise.allSettled(
    files.map(async (f) => {
      const content = await fetchFileAtCommit(env, project, repoId, f.path, sourceCommit, headers);
      return { file: f, content };
    })
  );

  for (const result of contentResults) {
    if (result.status !== "fulfilled") continue;
    const { file: f, content: newContent } = result.value;

    console.log(`(log) [Review] Processing file (${f.isAdd ? "add" : "edit"}): ${f.path}`);

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

  // ── Re-review tracking: load previous review issues ────────────────────
  let previousIssues = [];
  let reviewNumber = 1;
  const reviewKey = `review:${prId}`;
  try {
    if (env?.BOT_KV) {
      const stored = await env.BOT_KV.get(reviewKey, "json");
      if (stored && Array.isArray(stored.issues)) {
        previousIssues = stored.issues;
        reviewNumber = (stored.reviewNumber || 1) + 1;
        console.log(`(log) [Review] Found previous review for PR ${prId}: ${previousIssues.length} issues (iteration #${reviewNumber})`);
      }
    }
  } catch (e) {
    console.log("(log) [Review] KV read for previous review failed (proceeding as first review):", e.message);
  }

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

  // ── Re-review follow-up section ────────────────────────────────────────
  const currentIssues = extractIssues(allComments);
  if (previousIssues.length > 0) {
    const diff = diffReviewIssues(previousIssues, currentIssues);
    summary.push(buildFollowUpSection(diff, reviewNumber));
  }

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

    // Apply security-alert label to the PR (fire-and-forget)
    const labelUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/labels?api-version=${AZURE_API_VERSION}`;
    fetchWithTimeout(labelUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "security-alert" }),
    }).catch(e => console.log("(log) [Review] security-alert label error:", e.message));
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

  const summaryRes = await fetchWithRetry(threadBaseUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(summaryBody),
    retries: 3,
    tag: "Review",
  });

  if (summaryRes.ok) {
    console.log("(log) [Review] ✓ Unified review posted");

    // ── Store current issues for future re-review comparison ─────────────
    try {
      if (env?.BOT_KV) {
        await env.BOT_KV.put(reviewKey, JSON.stringify({
          issues: currentIssues,
          reviewNumber,
          timestamp: Date.now(),
        }), { expirationTtl: REVIEW_ISSUES_TTL });
        console.log(`(log) [Review] Stored ${currentIssues.length} issues for PR ${prId} (iteration #${reviewNumber})`);
      }
    } catch (e) {
      console.log("(log) [Review] KV write for review issues failed (non-critical):", e.message);
    }
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

    const headers = azureHeaders(azureToken);

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
      const headers = azureHeaders(azureToken);
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
      const headers = azureHeaders(azureToken);
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

    const headers = azureHeaders(azureToken);

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
      const headers = azureHeaders(payload.azureToken);
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

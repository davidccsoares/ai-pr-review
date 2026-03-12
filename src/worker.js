const ORG = "https://dev.azure.com/bindtuning";
const AZURE_API_VERSION = "7.0";
const MAX_DIFF_SIZE = 10000;
const MAX_FILE_DIFF = 4000;
const CONTEXT_LINES = 3;
const CF_AI_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";

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

    if (!payload?.resource?.pullRequestId) {
      console.log("(log) No pull request ID found");
      return new Response("No PR", { status: 200 });
    }

    ctx.waitUntil(processReview(payload, env));
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

/**
 * Simple and exact diff: compare old and new files line by line.
 * For each line in the new file, check if it differs from the old file at
 * the same position. Group consecutive changed lines into hunks with context.
 *
 * This is NOT an LCS diff — it's a positional comparison. It works perfectly
 * when lines are edited in-place (same line count or close), which is the
 * common case for small PRs. For added/removed lines, it detects the shift.
 */
function computeDiff(oldText, newText) {
  const oldLines = (oldText || "").split("\n");
  const newLines = (newText || "").split("\n");
  const maxLen = Math.max(oldLines.length, newLines.length);

  // 1. Find which lines in the new file are different
  const diffPositions = []; // indices (0-based) in new file that differ
  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;
    if (oldLine !== newLine) {
      diffPositions.push(i);
    }
  }

  if (diffPositions.length === 0) return { diff: "", changedLines: [] };

  // 2. Group into hunks (consecutive changes merged with context gap)
  const hunks = []; // each: { start, end } (0-based indices in new file)
  let hunkStart = diffPositions[0];
  let hunkEnd = diffPositions[0];

  for (let k = 1; k < diffPositions.length; k++) {
    if (diffPositions[k] - hunkEnd <= CONTEXT_LINES * 2 + 1) {
      hunkEnd = diffPositions[k];
    } else {
      hunks.push({ start: hunkStart, end: hunkEnd });
      hunkStart = diffPositions[k];
      hunkEnd = diffPositions[k];
    }
  }
  hunks.push({ start: hunkStart, end: hunkEnd });

  // 3. Format each hunk with context
  const output = [];
  const changedLines = [];

  for (const hunk of hunks) {
    const ctxStart = Math.max(0, hunk.start - CONTEXT_LINES);
    const ctxEnd = Math.min(newLines.length - 1, hunk.end + CONTEXT_LINES);

    output.push(`@@ line ${ctxStart + 1} @@`);

    for (let i = ctxStart; i <= ctxEnd; i++) {
      const isChanged = diffPositions.includes(i);
      const lineNum = i + 1; // 1-based
      const newLine = i < newLines.length ? newLines[i] : "";
      const oldLine = i < oldLines.length ? oldLines[i] : "";

      if (isChanged) {
        if (oldLine !== undefined && i < oldLines.length) {
          output.push(`-${lineNum}: ${oldLine}`);
        }
        if (i < newLines.length) {
          output.push(`+${lineNum}: ${newLine}`);
          changedLines.push(lineNum);
        }
      } else {
        output.push(` ${lineNum}: ${newLine}`);
        changedLines.push(lineNum);
      }
    }
    output.push("---");
  }

  return { diff: output.join("\n"), changedLines };
}

// ─── Risk Scoring ────────────────────────────────────────────────────────────

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

async function processReview(payload, env) {
  try {
    const prId = payload.resource.pullRequestId;
    const repoId = payload.resource.repository.id;
    const project = payload.resource.repository.project.name;
    const prTitle = payload.resource.title || "";
    const sourceCommit = payload.resource.lastMergeSourceCommit.commitId;
    const targetCommit = payload.resource.lastMergeTargetCommit.commitId;

    console.log(`(log) Processing PR ${prId}: "${prTitle}"`);
    console.log(`(log) Source: ${sourceCommit} | Target: ${targetCommit}`);

    const azureHeaders = {
      Authorization: `Basic ${btoa(":" + env.AZURE_TOKEN)}`,
    };

    // 1. Get latest iteration
    const iterUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations?api-version=${AZURE_API_VERSION}`;
    const iterRes = await fetch(iterUrl, { headers: azureHeaders });
    if (!iterRes.ok) {
      console.error("(log) Failed to fetch iterations:", iterRes.status);
      return;
    }
    const iterData = await iterRes.json();
    const latestIteration = Math.max(...iterData.value.map((i) => i.id));

    // 2. Get changed files
    const changesUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations/${latestIteration}/changes?api-version=${AZURE_API_VERSION}`;
    const changesRes = await fetch(changesUrl, { headers: azureHeaders });
    if (!changesRes.ok) {
      console.error("(log) Failed to fetch changes:", changesRes.status);
      return;
    }
    const changesData = await changesRes.json();
    const entries = changesData.changeEntries || changesData.changes || [];

    // 3. For each changed file, compute diff
    const fileChanges = [];
    let totalChangedLines = 0;

    for (const c of entries) {
      const path = c.item?.path;
      const changeType = c.changeType;
      const changeTrackingId = c.changeTrackingId;

      if (!path || path.endsWith("/")) continue;

      const ct = typeof changeType === "string" ? changeType.toLowerCase() : changeType;
      const isEdit = ct === "edit" || ct === 2;
      const isAdd = ct === "add" || ct === 1;
      if (!isEdit && !isAdd) continue;

      console.log(`(log) Processing file (${changeType}): ${path}`);

      const [oldContent, newContent] = await Promise.all([
        isEdit ? fetchFileAtCommit(project, repoId, path, targetCommit, azureHeaders) : Promise.resolve(null),
        fetchFileAtCommit(project, repoId, path, sourceCommit, azureHeaders),
      ]);

      if (newContent === null) {
        console.log("(log) Skipping (could not fetch):", path);
        continue;
      }

      let diff, changedLines;
      if (isEdit) {
        const result = computeDiff(oldContent, newContent);
        diff = result.diff;
        changedLines = result.changedLines;
      } else {
        const lines = newContent.split("\n").slice(0, 80);
        diff = lines.map((l, idx) => `+${idx + 1}: ${l}`).join("\n");
        changedLines = lines.map((_, idx) => idx + 1);
      }

      if (diff) {
        totalChangedLines += changedLines.length;
        console.log(`(log) ${path}: changed lines [${changedLines.slice(0, 15).join(",")}...]`);
        fileChanges.push({
          path,
          changeTrackingId,
          isAdd,
          diff: diff.substring(0, MAX_FILE_DIFF),
          changedLines,
        });
      }
    }

    if (fileChanges.length === 0) {
      console.log("(log) No reviewable changes found");
      return;
    }

    // 4. Build prompt with the diff hunks
    let diffBlock = "";
    for (const fc of fileChanges) {
      const header = `\n### FILE: ${fc.path} (${fc.isAdd ? "new file" : "edited"})`;
      const section = `${header}\n\`\`\`\n${fc.diff}\n\`\`\`\n`;
      if (diffBlock.length + section.length > MAX_DIFF_SIZE) {
        console.log("(log) Diff budget reached, skipping remaining files");
        break;
      }
      diffBlock += section;
    }

    const fileList = fileChanges.map((fc) => fc.path).join(", ");
    console.log(`(log) Files to review: ${fileList}`);
    console.log(`(log) Diff size for AI: ${diffBlock.length} chars`);

    // 4a. Compute risk score
    const riskScore = calculateRisk(fileChanges, totalChangedLines);
    const risk = riskLevel(riskScore);
    console.log(`(log) Risk score: ${riskScore}/100 (${risk})`);

    // 4b. Compute largest file changes (top 3 by diff length)
    const largestFiles = [...fileChanges]
      .sort((a, b) => b.diff.length - a.diff.length)
      .slice(0, 3)
      .map((fc) => fc.path);
    console.log(`(log) Largest changes: ${largestFiles.join(", ")}`);

    // 4c. AI PR summary (only for large PRs)
    let prSummary = null;
    if (diffBlock.length > 2000) {
      console.log("(log) Large PR detected, generating AI summary...");
      const summaryAiResponse = await env.AI.run(CF_AI_MODEL, {
        messages: [
          { role: "system", content: "You summarize pull requests." },
          {
            role: "user",
            content: `Explain this pull request in 3 concise bullet points.\n\nPR title: ${prTitle}\n\nChanges:\n${diffBlock.substring(0, 4000)}`,
          },
        ],
        max_tokens: 200,
      });
      prSummary = summaryAiResponse?.response || null;
      if (prSummary) {
        console.log("(log) PR summary generated");
      }
    } else {
      console.log("(log) Small PR, skipping AI summary");
    }

    const systemPrompt = `You are a senior code reviewer. Review ONLY the changed lines in the PR diff below.

OUTPUT FORMAT — respond with ONLY a raw JSON array, no markdown, no code fences:
[{"file":"/path/to/file.cs","line":42,"comment":"Your feedback"}]

RULES:
1. ONLY comment on lines prefixed with "+" (these are the changed/added lines)
2. NEVER comment on context lines (prefixed with a space) or removed lines (prefixed with "-")
3. "file" must exactly match the file path from the diff header
4. "line" must be the exact line number shown after the "+" prefix
5. NEVER repeat the same line number — one comment per line, max
6. Keep each comment concise (1-2 sentences)
7. Focus on: actual bugs, null reference risks, security vulnerabilities, clear logic errors
8. Do NOT guess or speculate — only flag issues you are certain about
9. Do NOT comment on code style, naming, or formatting
10. If the changed code looks correct, return: [{"file":"/path","line":1,"comment":"LGTM"}]`;

    const userPrompt = `PR: "${prTitle}"
Files changed: ${fileList}

${diffBlock}`;

    // 5. Call Cloudflare Workers AI
    console.log("(log) Calling AI...");
    const aiResponse = await env.AI.run(CF_AI_MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 1024,
    });

    // Workers AI may return a parsed object or a string depending on the model
    const rawResponse = aiResponse?.response;
    const rawReview = typeof rawResponse === "string"
      ? rawResponse
      : JSON.stringify(rawResponse, null, 2);
    console.log("(log) AI response:", rawReview);

    // 6. Parse response
    let comments;
    try {
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
    } catch (e) {
      console.error("(log) JSON parse failed:", e.message);
      comments = null;
    }

    const threadBaseUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=${AZURE_API_VERSION}`;

    // 7. Build a single PR-level summary comment
    const summary = [`## 🤖 AI Code Review`, ``];

    // PR Summary (only for large PRs)
    if (prSummary) {
      summary.push(`### 📋 PR Summary`, ``, prSummary, ``);
    }

    // Risk Analysis
    summary.push(
      `### ⚠ Risk Analysis`,
      ``,
      `Score: **${riskScore}/100**`,
      `Level: **${risk}**`,
      ``,
      `Files reviewed: ${fileChanges.length}`,
      ``
    );

    // Largest Changes
    if (largestFiles.length > 0) {
      summary.push(`### Largest Changes`, ``);
      for (const f of largestFiles) {
        const fileName = f.split("/").pop();
        summary.push(`* ${fileName}`);
      }
      summary.push(``);
    }

    if (comments && comments.length > 0) {
      const byFile = {};
      for (const c of comments) {
        if (!c.file || !c.comment) continue;
        if (!byFile[c.file]) byFile[c.file] = [];
        byFile[c.file].push(c);
      }

      let hasIssues = false;
      for (const fc of fileChanges) {
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
    } else if (comments === null) {
      summary.push(`### Review`, ``, rawReview || "No review content returned.");
    } else {
      summary.push(`✅ **No issues found.** Code looks good!`);
    }

    // 8. Post the summary
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
      console.log("(log) ✓ Review posted");
    } else {
      console.error("(log) ✗ Post failed:", summaryRes.status, await summaryRes.text());
    }

    console.log(`(log) Done! PR ${prId}`);
  } catch (err) {
    console.error("(log) Error:", err.stack || err);
  }
}

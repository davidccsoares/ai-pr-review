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
 * Compute hunks between old and new file, outputting ONLY changed regions
 * with CONTEXT_LINES of surrounding context. Line numbers refer to the NEW file.
 *
 * Output format (each hunk separated by "---"):
 *   @@ lines NEW_START-NEW_END @@
 *    42: unchanged context line
 *   -43: removed line (old file)
 *   +43: added line (new file)
 *    44: unchanged context line
 */
function computeHunks(oldText, newText) {
  const oldLines = (oldText || "").split("\n");
  const newLines = (newText || "").split("\n");

  // 1. Find all change positions using LCS-style scan
  const changes = []; // { oldStart, oldEnd, newStart, newEnd }
  let i = 0;
  let j = 0;

  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
      continue;
    }
    // Start of a change block
    const oldStart = i;
    const newStart = j;

    // Scan forward to find where lines match again
    let found = false;
    for (let radius = 1; radius < 50 && !found; radius++) {
      // Check if skipping `radius` old lines re-syncs
      if (i + radius < oldLines.length && oldLines[i + radius] === newLines[j]) {
        changes.push({ oldStart, oldEnd: i + radius, newStart, newEnd: j });
        i = i + radius;
        found = true;
      }
      // Check if skipping `radius` new lines re-syncs
      if (!found && j + radius < newLines.length && oldLines[i] === newLines[j + radius]) {
        changes.push({ oldStart, oldEnd: i, newStart, newEnd: j + radius });
        j = j + radius;
        found = true;
      }
      // Check diagonal skip
      if (!found && i + radius < oldLines.length && j + radius < newLines.length && oldLines[i + radius] === newLines[j + radius]) {
        changes.push({ oldStart, oldEnd: i + radius, newStart, newEnd: j + radius });
        i = i + radius;
        j = j + radius;
        found = true;
      }
    }

    if (!found) {
      // Can't re-sync within radius, treat rest as one big change
      changes.push({ oldStart, oldEnd: oldLines.length, newStart, newEnd: newLines.length });
      i = oldLines.length;
      j = newLines.length;
    }
  }

  // Handle trailing lines
  if (i < oldLines.length || j < newLines.length) {
    changes.push({ oldStart: i, oldEnd: oldLines.length, newStart: j, newEnd: newLines.length });
  }

  if (changes.length === 0) return { hunks: "", changedLines: [] };

  // 2. Merge nearby changes into hunks (merge if gap <= CONTEXT_LINES * 2)
  const merged = [changes[0]];
  for (let k = 1; k < changes.length; k++) {
    const prev = merged[merged.length - 1];
    const curr = changes[k];
    if (curr.newStart - prev.newEnd <= CONTEXT_LINES * 2) {
      prev.oldEnd = curr.oldEnd;
      prev.newEnd = curr.newEnd;
    } else {
      merged.push({ ...curr });
    }
  }

  // 3. Format hunks
  const output = [];
  const changedLines = []; // Track actual new-file line numbers that were changed

  for (const hunk of merged) {
    const ctxBefore = Math.max(0, hunk.newStart - CONTEXT_LINES);
    const ctxAfter = Math.min(newLines.length, hunk.newEnd + CONTEXT_LINES);

    output.push(`@@ lines ${ctxBefore + 1}-${ctxAfter} @@`);

    // Context before
    for (let c = ctxBefore; c < hunk.newStart; c++) {
      output.push(` ${c + 1}: ${newLines[c]}`);
    }

    // Removed lines (from old file)
    for (let r = hunk.oldStart; r < hunk.oldEnd; r++) {
      output.push(`-    : ${oldLines[r]}`);
    }

    // Added lines (from new file) — these have the real line numbers
    for (let a = hunk.newStart; a < hunk.newEnd; a++) {
      output.push(`+${a + 1}: ${newLines[a]}`);
      changedLines.push(a + 1);
    }

    // Context after
    for (let c = hunk.newEnd; c < ctxAfter; c++) {
      output.push(` ${c + 1}: ${newLines[c]}`);
    }

    output.push("---");
  }

  return { hunks: output.join("\n"), changedLines };
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

    // 3. For each changed file, compute hunks (only changed lines + context)
    const fileChanges = [];

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
        const result = computeHunks(oldContent, newContent);
        diff = result.hunks;
        changedLines = result.changedLines;
      } else {
        // For new files, show first N lines
        const lines = newContent.split("\n").slice(0, 80);
        diff = lines.map((l, idx) => `+${idx + 1}: ${l}`).join("\n");
        changedLines = lines.map((_, idx) => idx + 1);
      }

      if (diff) {
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

    // 4. Build prompt with only the changed hunks
    let diffBlock = "";
    for (const fc of fileChanges) {
      const header = `\n### FILE: ${fc.path} (${fc.isAdd ? "new file" : "edited"})`;
      const validLines = `\nValid line numbers for comments: [${fc.changedLines.slice(0, 30).join(", ")}]`;
      const section = `${header}${validLines}\n\`\`\`\n${fc.diff}\n\`\`\`\n`;
      if (diffBlock.length + section.length > MAX_DIFF_SIZE) {
        console.log("(log) Diff budget reached, skipping remaining files");
        break;
      }
      diffBlock += section;
    }

    const fileList = fileChanges.map((fc) => fc.path).join(", ");
    console.log(`(log) Files to review: ${fileList}`);
    console.log(`(log) Diff size for AI: ${diffBlock.length} chars`);

    const systemPrompt = `You are a senior code reviewer. Review the PR diff below and return structured JSON.

OUTPUT FORMAT — respond with ONLY a JSON array, nothing else:
[{"file":"/path","line":42,"comment":"Your feedback here"}]

RULES:
1. "file" must exactly match the file path shown in the diff header
2. "line" MUST be one of the valid line numbers listed for that file (from the "+" added lines)
3. Keep each comment concise (1-2 sentences)
4. Focus on: bugs, null/undefined risks, security, performance, logic errors
5. Skip trivial style issues
6. Max 5 comments total across all files
7. If code is fine, return: [{"file":"/path","line":1,"comment":"LGTM"}]`;

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

    const rawReview = aiResponse?.response || "";
    console.log("(log) AI response:", rawReview);

    // 6. Parse response
    let comments;
    try {
      const jsonMatch = rawReview.match(/\[[\s\S]*?\]/);
      comments = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      if (!Array.isArray(comments)) comments = [];
    } catch (e) {
      console.error("(log) JSON parse failed:", e.message);
      comments = null;
    }

    const threadBaseUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=${AZURE_API_VERSION}`;

    // 7. Post inline comments
    let posted = 0;
    if (comments && comments.length > 0) {
      for (const c of comments) {
        const filePath = c.file;
        let line = parseInt(c.line, 10);
        const commentText = c.comment;
        if (!filePath || !commentText) continue;

        const fileChange = fileChanges.find((fc) => fc.path === filePath);

        // Validate line number — must be within the changed lines
        if (fileChange && !fileChange.changedLines.includes(line)) {
          // Snap to nearest valid changed line
          const nearest = fileChange.changedLines.reduce((best, l) =>
            Math.abs(l - line) < Math.abs(best - line) ? l : best
          , fileChange.changedLines[0]);
          console.log(`(log) Snapping line ${line} -> ${nearest} for ${filePath}`);
          line = nearest;
        }

        if (!line || line < 1) line = 1;

        const threadBody = {
          comments: [
            {
              parentCommentId: 0,
              content: `🤖 **AI Review**\n\n${commentText}`,
              commentType: 1,
            },
          ],
          status: 4,
          threadContext: {
            filePath,
            rightFileStart: { line, offset: 1 },
            rightFileEnd: { line, offset: 1 },
          },
        };

        if (fileChange?.changeTrackingId) {
          threadBody.pullRequestThreadContext = {
            changeTrackingId: fileChange.changeTrackingId,
            iterationContext: {
              firstComparingIteration: 1,
              secondComparingIteration: latestIteration,
            },
          };
        }

        const threadRes = await fetch(threadBaseUrl, {
          method: "POST",
          headers: { ...azureHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(threadBody),
        });

        if (threadRes.ok) {
          posted++;
          console.log(`(log) ✓ Inline comment on ${filePath}:${line}`);
        } else {
          const errBody = await threadRes.text();
          console.error(`(log) ✗ Failed ${filePath}:${line} (${threadRes.status}): ${errBody}`);
        }
      }
    }

    // 8. Post PR-level summary
    const summaryLines = [
      `## 🤖 AI Code Review Summary`,
      ``,
      `**PR:** ${prTitle}`,
      `**Files reviewed:** ${fileChanges.length}`,
      ``,
      `| File | Status |`,
      `|------|--------|`,
    ];

    for (const fc of fileChanges) {
      const relevant = (comments || []).filter((c) => c.file === fc.path);
      const status = relevant.length === 0
        ? "✅ No issues"
        : relevant.every((c) => c.comment?.includes("LGTM"))
          ? "✅ Looks good"
          : `💬 ${relevant.length} comment(s)`;
      summaryLines.push(`| \`${fc.path.split("/").pop()}\` | ${status} |`);
    }

    if (posted > 0) {
      summaryLines.push("", `📝 **${posted} inline comment(s)** posted on specific lines above.`);
    } else if (comments === null) {
      // AI response couldn't be parsed — include it in the summary
      summaryLines.push("", "### Review", "", rawReview || "No review content returned.");
    } else {
      summaryLines.push("", "✅ **No issues found.** Code looks good!");
    }

    const summaryBody = {
      comments: [
        {
          parentCommentId: 0,
          content: summaryLines.join("\n"),
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
      console.log("(log) ✓ Summary posted");
    } else {
      console.error("(log) ✗ Summary failed:", summaryRes.status);
    }

    console.log(`(log) Done! PR ${prId}: ${posted} inline + 1 summary`);
  } catch (err) {
    console.error("(log) Error:", err.stack || err);
  }
}

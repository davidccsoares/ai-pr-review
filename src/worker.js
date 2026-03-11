const ORG = "https://dev.azure.com/bindtuning";
const AZURE_API_VERSION = "7.0";
const MAX_DIFF_SIZE = 12000;
const MAX_FILE_SIZE = 3000;
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

    // Respond immediately to Azure DevOps so it doesn't retry/timeout.
    // The heavy work (fetching diffs, calling LLM, posting comments) runs in the background.
    ctx.waitUntil(processReview(payload, env));

    return new Response("Accepted", { status: 202 });
  },
};

/**
 * Fetch a file's content from Azure DevOps at a specific commit.
 * Returns the text content or null if the file doesn't exist.
 */
async function fetchFileAtCommit(project, repoId, path, commitId, headers) {
  const url = `${ORG}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(
    path
  )}&versionDescriptor.version=${commitId}&versionDescriptor.versionType=commit&includeContent=true&api-version=${AZURE_API_VERSION}`;

  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return res.text();
}

/**
 * Compute a simple unified-style diff between two file versions.
 * Shows only the changed lines with surrounding context, including line numbers.
 */
function computeSimpleDiff(oldText, newText) {
  const oldLines = (oldText || "").split("\n");
  const newLines = (newText || "").split("\n");

  const result = [];
  const contextLines = 3;
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++;
      j++;
      continue;
    }

    // Found a difference — show context before
    const contextStart = Math.max(0, j - contextLines);
    for (let c = contextStart; c < j; c++) {
      result.push(`  ${c + 1}: ${newLines[c]}`);
    }

    // Find the end of the differing block
    let oldEnd = i;
    let newEnd = j;
    while (oldEnd < oldLines.length && newEnd < newLines.length && oldLines[oldEnd] !== newLines[newEnd]) {
      oldEnd++;
      newEnd++;
    }
    if (oldEnd >= oldLines.length || newEnd >= newLines.length) {
      while (oldEnd < oldLines.length) oldEnd++;
      while (newEnd < newLines.length) newEnd++;
    }

    for (let r = i; r < oldEnd; r++) {
      result.push(`- ${r + 1}: ${oldLines[r]}`);
    }
    for (let a = j; a < newEnd; a++) {
      result.push(`+ ${a + 1}: ${newLines[a]}`);
    }

    // Context after
    const contextEnd = Math.min(newLines.length, newEnd + contextLines);
    for (let c = newEnd; c < contextEnd; c++) {
      result.push(`  ${c + 1}: ${newLines[c]}`);
    }

    i = oldEnd;
    j = newEnd;
  }

  return result.join("\n");
}

async function processReview(payload, env) {
  try {
    const prId = payload.resource.pullRequestId;
    const repoId = payload.resource.repository.id;
    const project = payload.resource.repository.project.name;
    const sourceCommit = payload.resource.lastMergeSourceCommit.commitId;
    const targetCommit = payload.resource.lastMergeTargetCommit.commitId;

    console.log(`(log) Processing PR ${prId} | Project: ${project}`);
    console.log(`(log) Source: ${sourceCommit} | Target: ${targetCommit}`);

    const azureHeaders = {
      Authorization: `Basic ${btoa(":" + env.AZURE_TOKEN)}`,
    };

    // 1. Fetch PR iterations to get the latest
    const iterUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations?api-version=${AZURE_API_VERSION}`;
    const iterRes = await fetch(iterUrl, { headers: azureHeaders });
    if (!iterRes.ok) {
      console.error("(log) Failed to fetch iterations:", iterRes.status, await iterRes.text());
      return;
    }
    const iterData = await iterRes.json();
    const latestIteration = Math.max(...iterData.value.map((i) => i.id));
    console.log("(log) Latest iteration:", latestIteration);

    // 2. Fetch changes for this iteration
    const changesUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations/${latestIteration}/changes?api-version=${AZURE_API_VERSION}`;
    const changesRes = await fetch(changesUrl, { headers: azureHeaders });
    if (!changesRes.ok) {
      console.error("(log) Failed to fetch changes:", changesRes.status, await changesRes.text());
      return;
    }
    const changesData = await changesRes.json();

    const entries = changesData.changeEntries || changesData.changes || [];
    const fileChanges = [];

    for (const c of entries) {
      const path = c.item?.path;
      const changeType = c.changeType;
      const changeTrackingId = c.changeTrackingId;

      if (!path || path.endsWith("/")) continue;

      const normalizedType =
        typeof changeType === "string" ? changeType.toLowerCase() : changeType;
      const isEdit = normalizedType === "edit" || normalizedType === 2;
      const isAdd = normalizedType === "add" || normalizedType === 1;
      if (!isEdit && !isAdd) continue;

      console.log(`(log) File changed (${changeType}): ${path}`);

      // 3. Fetch both old and new versions of the file
      const [oldContent, newContent] = await Promise.all([
        isEdit ? fetchFileAtCommit(project, repoId, path, targetCommit, azureHeaders) : Promise.resolve(null),
        fetchFileAtCommit(project, repoId, path, sourceCommit, azureHeaders),
      ]);

      if (newContent === null) {
        console.log("(log) Could not fetch new version of:", path);
        continue;
      }

      const diff = isEdit
        ? computeSimpleDiff(oldContent, newContent)
        : newContent.substring(0, MAX_FILE_SIZE);

      if (diff) {
        fileChanges.push({
          path,
          changeTrackingId,
          isAdd,
          diff: diff.substring(0, MAX_FILE_SIZE),
        });
      }
    }

    if (fileChanges.length === 0) {
      console.log("(log) No file changes to review");
      return;
    }

    // 4. Build the prompt with actual diffs
    let diffBlock = "";
    for (const fc of fileChanges) {
      const section = `\n### FILE: ${fc.path} (${fc.isAdd ? "added" : "edited"})\n${fc.diff}\n`;
      if (diffBlock.length + section.length > MAX_DIFF_SIZE) break;
      diffBlock += section;
    }

    console.log("(log) Total diff size for LLM:", diffBlock.length);

    const systemPrompt = `You are a senior software engineer reviewing a pull request.
Analyze code changes and return review comments as a JSON array.

RULES:
- Respond ONLY with a valid JSON array. No markdown fences, no explanation outside the JSON.
- Each element: {"file": "<path>", "line": <int>, "comment": "<text>"}
- "file" must match the file path exactly as shown
- "line" is the line number in the NEW version (from "+" prefixed lines)
- Focus on: bugs, logic errors, null references, security, performance, best practices
- If the code looks good, return: [{"file":"<path>","line":1,"comment":"LGTM - code looks good."}]`;

    const userPrompt = `Review these changes:
${diffBlock}`;

    // 5. Call Cloudflare Workers AI (runs on the edge, no external HTTP call)
    console.log("(log) Calling Workers AI model:", CF_AI_MODEL);
    const aiResponse = await env.AI.run(CF_AI_MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const rawReview = aiResponse?.response || "";
    console.log("(log) AI response:", rawReview);

    // 6. Parse AI response into structured comments
    let comments;
    try {
      const jsonMatch = rawReview.match(/\[[\s\S]*\]/);
      comments = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (e) {
      console.error("(log) Failed to parse AI JSON, falling back to single comment:", e.message);
      comments = null;
    }

    const threadBaseUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=${AZURE_API_VERSION}`;

    if (comments && comments.length > 0) {
      // 7a. Post each comment as an inline thread on the specific file + line
      let posted = 0;
      for (const c of comments) {
        const filePath = c.file;
        const line = parseInt(c.line, 10) || 1;
        const commentText = c.comment;
        if (!filePath || !commentText) continue;

        const fileChange = fileChanges.find((fc) => fc.path === filePath);

        const threadBody = {
          comments: [
            {
              parentCommentId: 0,
              content: `🤖 **AI Review**\n\n${commentText}`,
              commentType: 1,
            },
          ],
          status: 4, // closed (informational)
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
          console.log(`(log) Posted inline comment on ${filePath}:${line}`);
        } else {
          console.error(`(log) Failed to post on ${filePath}:${line}:`, threadRes.status, await threadRes.text());
        }
      }
      console.log(`(log) Posted ${posted}/${comments.length} inline comments on PR ${prId}`);
    } else {
      // 7b. Fallback: post raw review as a single PR-level comment
      const threadBody = {
        comments: [
          {
            parentCommentId: 0,
            content: `## 🤖 AI Code Review\n\n${rawReview || "No review content returned."}`,
            commentType: 1,
          },
        ],
        status: 4,
      };

      const threadRes = await fetch(threadBaseUrl, {
        method: "POST",
        headers: { ...azureHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(threadBody),
      });

      if (threadRes.ok) {
        console.log("(log) Posted PR-level comment on PR", prId);
      } else {
        console.error("(log) Failed to post PR comment:", threadRes.status, await threadRes.text());
      }
    }

    console.log(`(log) Review complete for PR ${prId}`);
  } catch (err) {
    console.error("(log) Error in processReview:", err.stack || err);
  }
}

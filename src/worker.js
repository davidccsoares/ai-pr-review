const ORG = "https://dev.azure.com/bindtuning";
const AZURE_API_VERSION = "7.0";
const MAX_DIFF_SIZE = 12000;
const MAX_FILE_SIZE = 2000;
const OPENROUTER_MODEL = "stepfun/step-3.5-flash:free";

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method !== "POST") {
        return new Response("Only POST allowed", { status: 405 });
      }

      const payload = await request.json();
      console.log("(log) Webhook received");
      console.log("(log) Payload:", JSON.stringify(payload));

      if (!payload?.resource?.pullRequestId) {
        console.log("(log) No pull request ID found");
        return new Response("No PR", { status: 200 });
      }

      const prId = payload.resource.pullRequestId;
      const repoId = payload.resource.repository.id;
      const project = payload.resource.repository.project.name;
      const lastCommit = payload.resource.lastMergeSourceCommit.commitId;

      console.log("(log) PR:", prId);
      console.log("(log) Repo ID:", repoId);
      console.log("(log) Project:", project);

      const azureHeaders = {
        Authorization: `Basic ${btoa(":" + env.AZURE_TOKEN)}`,
      };

      // Fetch PR iterations to get the latest
      const iterUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations?api-version=${AZURE_API_VERSION}`;
      const iterRes = await fetch(iterUrl, { headers: azureHeaders });
      if (!iterRes.ok) {
        const body = await iterRes.text();
        console.error("(log) Failed to fetch iterations:", iterRes.status, body);
        return new Response("Failed to fetch iterations", { status: 502 });
      }
      const iterData = await iterRes.json();
      const latestIteration = Math.max(...iterData.value.map((i) => i.id));
      console.log("(log) Latest iteration:", latestIteration);

      // Fetch changes for this iteration
      const changesUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations/${latestIteration}/changes?api-version=${AZURE_API_VERSION}`;
      const changesRes = await fetch(changesUrl, { headers: azureHeaders });
      if (!changesRes.ok) {
        const body = await changesRes.text();
        console.error("(log) Failed to fetch changes:", changesRes.status, body);
        return new Response("Failed to fetch changes", { status: 502 });
      }
      const changesData = await changesRes.json();
      console.log("(log) Changes response:", JSON.stringify(changesData));

      let diff = "";
      const entries = changesData.changeEntries || changesData.changes || [];
      for (const c of entries) {
        const path = c.item?.path;
        const changeType = c.changeType;

        if (!path || path.endsWith("/")) continue; // skip directories

        // Azure DevOps changeType can be numeric (1=add, 2=edit) or string
        const normalizedType =
          typeof changeType === "string" ? changeType.toLowerCase() : changeType;
        const isRelevant =
          normalizedType === "edit" ||
          normalizedType === "add" ||
          normalizedType === 1 ||
          normalizedType === 2;
        if (!isRelevant) continue;

        console.log("(log) File changed:", path);

        const fileUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(
          path
        )}&versionDescriptor.version=${lastCommit}&versionDescriptor.versionType=commit&includeContent=true&api-version=${AZURE_API_VERSION}`;

        const fileRes = await fetch(fileUrl, { headers: azureHeaders });
        if (!fileRes.ok) {
          console.log("(log) Failed to fetch file:", path, fileRes.status);
          continue;
        }

        const content = await fileRes.text();
        const fileChunk = `\nFILE: ${path}\n${content.substring(0, MAX_FILE_SIZE)}`;

        // Respect overall diff size limit
        if (diff.length + fileChunk.length > MAX_DIFF_SIZE) {
          console.log("(log) Diff size limit reached, skipping remaining files");
          break;
        }
        diff += fileChunk;
      }

      if (!diff) {
        console.log("(log) No diff found, skipping review");
        return new Response("No diff", { status: 200 });
      }

      console.log("(log) Diff size:", diff.length);

      // Call OpenRouter LLM for code review
      const prompt = `You are a senior software engineer. Review the following code changes from a pull request.
Provide actionable feedback grouped by file.
Format each comment as: [file]:[line] - description

Diff:
${diff}`;

      const llmRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!llmRes.ok) {
        const body = await llmRes.text();
        console.error("(log) LLM request failed:", llmRes.status, body);
        return new Response("LLM request failed", { status: 502 });
      }

      const llmData = await llmRes.json();
      const reviewText =
        llmData.choices?.[0]?.message?.content || "No review content returned.";

      console.log("(log) LLM review:", reviewText);

      // Post the review back to Azure DevOps as a PR comment thread
      const threadUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=${AZURE_API_VERSION}`;
      const threadBody = {
        comments: [
          {
            parentCommentId: 0,
            content: `## 🤖 AI Code Review\n\n${reviewText}`,
            commentType: 1, // 1 = text
          },
        ],
        status: 4, // 4 = closed (informational, not blocking)
      };

      const threadRes = await fetch(threadUrl, {
        method: "POST",
        headers: {
          ...azureHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(threadBody),
      });

      if (!threadRes.ok) {
        const body = await threadRes.text();
        console.error("(log) Failed to post PR comment:", threadRes.status, body);
        return new Response("Review generated but failed to post comment", {
          status: 502,
        });
      }

      console.log("(log) Review posted to PR successfully");
      return new Response("Review posted", { status: 200 });
    } catch (err) {
      console.error("(log) Error:", err.stack || err);
      return new Response(err.message || "Internal error", { status: 500 });
    }
  },
};

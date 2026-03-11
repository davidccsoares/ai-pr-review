import fetch from "node-fetch";

const ORG = "https://dev.azure.com/bindtuning";
const AZURE_API_VERSION = "7.0";
const MAX_DIFF_SIZE = 12000;
const OPENROUTER_MODEL = "stepfun/step-3.5-flash:free";

export default {
  async fetch(request) {
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

      // Fetch PR iterations to get latest
      const headers = {
        Authorization: `Basic ${btoa(":" + AZURE_TOKEN)}`,
      };

      const iterUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations?api-version=${AZURE_API_VERSION}`;
      const iterRes = await fetch(iterUrl, { headers });
      const iterData = await iterRes.json();
      const latestIteration = Math.max(...iterData.value.map(i => i.id));
      console.log("(log) Latest iteration:", latestIteration);

      // Fetch changes for this iteration
      const changesUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations/${latestIteration}/changes?api-version=${AZURE_API_VERSION}`;
      const changesRes = await fetch(changesUrl, { headers });
      const changesData = await changesRes.json();
      console.log("(log) Changes response:", JSON.stringify(changesData));

      let diff = "";
      for (const c of changesData.changeEntries || changesData.changes || []) {
        const path = c.item?.path;
        const changeType = c.changeType;

        if (!path || path.endsWith("/")) continue; // ignorar pastas
        if (!["edit", "add"].includes(changeType)) continue;

        console.log("(log) File changed:", path);

        const fileUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(
          path
        )}&versionDescriptor.version=${lastCommit}&versionDescriptor.versionType=commit&includeContent=true&api-version=${AZURE_API_VERSION}`;

        const fileRes = await fetch(fileUrl, { headers });
        if (fileRes.status !== 200) {
          console.log("(log) Failed to fetch file:", path);
          continue;
        }

        const content = await fileRes.text();
        diff += `\nFILE: ${path}\n`;
        diff += content.substring(0, 2000); // limite por ficheiro
      }

      if (!diff) {
        console.log("(log) No diff found, skipping review");
        return new Response("No diff", { status: 200 });
      }

      console.log("(log) Diff size:", diff.length);

      // Chamada à OpenRouter
      const prompt = `You are a senior software engineer. Review the following code changes.\nFormat: [file]:[line] - description\n\nDiff:\n${diff}`;

      const llmRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const llmData = await llmRes.json();
      const reviewText = llmData.choices?.[0]?.message?.content || "Error: No review returned";

      console.log("(log) LLM review:", reviewText);

      // TODO: Post review back to Azure PR as comment (requires Azure DevOps PR threads API)
      // Para já só log
      console.log("(log) Review completed");

      return new Response("Webhook processed", { status: 200 });
    } catch (err) {
      console.error("(log) Error:", err);
      return new Response(err.message || "Error", { status: 500 });
    }
  },
};
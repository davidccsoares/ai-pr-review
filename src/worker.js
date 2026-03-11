const MAX_DIFF_SIZE = 12000;

export default {
  async fetch(request, env) {

    console.log("Webhook received");

    if (request.method !== "POST") {
      console.log("Not POST request");
      return new Response("ok");
    }

    let data;

    try {
      data = await request.json();
      console.log("Payload:", JSON.stringify(data));
    } catch (e) {
      console.log("Invalid JSON", e);
      return new Response("Invalid JSON");
    }

    if (!data.resource || !data.resource.pullRequestId) {
      console.log("No PR data in payload");
      return new Response("Webhook received (no PR)");
    }

    const pr = data.resource;

    const prId = pr.pullRequestId;
    const repoId = pr.repository.id;
    const project = pr.repository.project.name;

    console.log("PR ID:", prId);
    console.log("Repo ID:", repoId);
    console.log("Project:", project);

    const org = env.AZURE_ORG;
    const token = env.AZURE_TOKEN;
    const openrouterKey = env.OPENROUTER_KEY;

    const auth = btoa(":" + token);
    const headers = { Authorization: `Basic ${auth}` };

    try {

      console.log("Fetching PR iterations...");

      const iterRes = await fetch(
        `${org}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations?api-version=7.0`,
        { headers }
      );

      const iterations = await iterRes.json();

      console.log("Iterations:", JSON.stringify(iterations));

      const latest = iterations.value.at(-1);
      const iterationId = latest.id;

      console.log("Latest iteration:", iterationId);

      const sourceCommit = latest.targetRefCommit?.commitId;
      const targetCommit = latest.sourceRefCommit?.commitId;

      console.log("Source commit:", sourceCommit);
      console.log("Target commit:", targetCommit);

      console.log("Fetching changes...");

      const changesRes = await fetch(
        `${org}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations/${iterationId}/changes?api-version=7.0`,
        { headers }
      );

      const changesData = await changesRes.json();

      console.log("Changes response:", JSON.stringify(changesData));

      const changeList = changesData.changeEntries || [];

      console.log("Files changed:", changeList.length);

      if (!changeList.length) {
        console.log("No changes found");
        await postSummary(prId, repoId, project, "No changes detected.", headers, org);
        return new Response("done");
      }

      let totalSize = 0;
      let diffText = "";
      const fileDiffs = {};

      for (const c of changeList) {

        if (!c.item || c.isFolder) continue;

        const path = c.item.path;

        console.log("Processing file:", path);

        const baseContent = await getFileContent(org, project, repoId, path, sourceCommit, headers);
        const targetContent = await getFileContent(org, project, repoId, path, targetCommit, headers);

        const fileDiff = unifiedDiff(baseContent, targetContent, path);

        if (!fileDiff) {
          console.log("No diff for", path);
          continue;
        }

        const fileDiffStr = fileDiff.join("\n");

        if (totalSize + fileDiffStr.length > MAX_DIFF_SIZE) {
          console.log("Diff truncated due to size");
          diffText += "\n... (truncated — max diff reached)";
          break;
        }

        diffText += fileDiffStr + "\n";
        totalSize += fileDiffStr.length;

        fileDiffs[path] = fileDiffStr;
      }

      console.log("Total diff size:", diffText.length);

      if (!diffText.trim()) diffText = "No meaningful changes.";

      console.log("Calling OpenRouter...");

      const review = await askLLM(diffText, openrouterKey);

      console.log("LLM response:", review);

      const existingComments = await getExistingComments(org, project, repoId, prId, headers);

      console.log("Existing comments found:", existingComments.size);

      await postInlineComments(
        prId,
        repoId,
        project,
        review,
        fileDiffs,
        headers,
        existingComments,
        org
      );

      console.log("Inline comments posted");

      await postSummary(prId, repoId, project, review, headers, org);

      console.log("Summary comment posted");

      return new Response("done");

    } catch (e) {

      console.log("Worker error:", e);

      return new Response("Error: " + e.toString(), { status: 500 });
    }
  }
};


async function getFileContent(org, project, repoId, path, commitId, headers) {

  if (!commitId || commitId === "0000000000000000000000000000000000000000")
    return [];

  const safePath = encodeURIComponent(path);

  const url =
    `${org}/${project}/_apis/git/repositories/${repoId}/items` +
    `?path=${safePath}` +
    `&versionDescriptor.version=${commitId}` +
    `&versionDescriptor.versionType=commit` +
    `&includeContent=true` +
    `&api-version=7.0`;

  const r = await fetch(url, { headers });

  if (r.status !== 200) {
    console.log("Could not fetch file", path, r.status);
    return [];
  }

  const text = await r.text();
  return text.split("\n");
}


function unifiedDiff(a, b, path) {

  const diff = [];

  const maxLen = Math.max(a.length, b.length);

  for (let i = 0; i < maxLen; i++) {

    const lineA = a[i] || "";
    const lineB = b[i] || "";

    if (lineA !== lineB) {
      diff.push(`${path}:${i + 1} - ${lineB || "[deleted]"}`);
    }
  }

  return diff.length ? diff : null;
}


async function askLLM(diffText, key) {

  try {

    const r = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "stepfun/step-3.5-flash:free",
          messages: [
            {
              role: "user",
              content:
                `You are a senior software engineer reviewing code.\n\n` +
                `Identify bugs, security issues, and performance problems.\n` +
                `Format: file:line - issue\n\n` +
                diffText
            }
          ]
        })
      }
    );

    const json = await r.json();

    return json.choices?.[0]?.message?.content || "LLM returned empty";

  } catch (e) {

    console.log("OpenRouter error:", e);

    return `Error calling LLM: ${e}`;
  }
}


async function getExistingComments(org, project, repoId, prId, headers) {

  const url =
    `${org}/${project}/_apis/git/repositories/${repoId}` +
    `/pullRequests/${prId}/threads?api-version=7.0`;

  const r = await fetch(url, { headers });

  if (r.status !== 200) return new Set();

  const threads = (await r.json()).value || [];

  const existing = new Set();

  for (const thread of threads) {

    const ctx = thread.threadContext;

    if (!ctx) continue;

    const file = ctx.filePath;
    const line = ctx.rightFileStart?.line;

    for (const c of thread.comments || []) {
      existing.add(`${file}:${line}:${c.content}`);
    }
  }

  return existing;
}


async function postInlineComments(
  prId,
  repoId,
  project,
  review,
  fileDiffs,
  headers,
  existingComments,
  org
) {

  const url =
    `${org}/${project}/_apis/git/repositories/${repoId}` +
    `/pullRequests/${prId}/threads?api-version=7.0`;

  for (const line of review.split("\n")) {

    if (!line.includes(":") || !line.includes("-")) continue;

    try {

      const [meta, content] = line.split("-", 2);
      const [file, lineNumStr] = meta.split(":");

      const lineNum = parseInt(lineNumStr, 10);

      const key = `${file}:${lineNum}:${content.trim()}`;

      if (existingComments.has(key)) continue;

      existingComments.add(key);

      const payload = {
        comments: [
          {
            parentCommentId: 0,
            content: content.trim(),
            commentType: 1
          }
        ],
        status: 1,
        threadContext: {
          filePath: file.startsWith("/") ? file : `/${file}`,
          rightFileStart: { line: lineNum, offset: 1 },
          rightFileEnd: { line: lineNum, offset: 1 }
        }
      };

      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

    } catch (e) {

      console.log("Skipping inline comment:", e);
    }
  }
}


async function postSummary(prId, repoId, project, review, headers, org) {

  const url =
    `${org}/${project}/_apis/git/repositories/${repoId}` +
    `/pullRequests/${prId}/threads?api-version=7.0`;

  const payload = {
    comments: [
      {
        parentCommentId: 0,
        content: `🤖 **AI Review Summary**\n\n${review}`,
        commentType: 1
      }
    ],
    status: 1
  };

  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
}
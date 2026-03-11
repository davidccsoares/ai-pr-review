const MAX_PATCH = 12000;

export default {
  async fetch(request, env) {

    console.log("Webhook received");

    if (request.method !== "POST")
      return new Response("ok");

    const data = await request.json();

    if (!data.resource?.pullRequestId)
      return new Response("not a PR");

    const pr = data.resource;

    const prId = pr.pullRequestId;
    const repoId = pr.repository.id;
    const project = pr.repository.project.name;

    console.log("PR:", prId);

    const org = env.AZURE_ORG;
    const token = env.AZURE_TOKEN;
    const openrouter = env.OPENROUTER_KEY;

    const auth = btoa(":" + token);

    const headers = {
      Authorization: `Basic ${auth}`
    };

    try {

      const diff = await getAzureDiff(org, project, repoId, prId, headers);

      console.log("Diff size:", diff.length);

      if (!diff.trim()) {
        console.log("No diff");
        return new Response("no changes");
      }

      const review = await askLLM(diff, openrouter);

      console.log("LLM review:", review);

      const existing = await getExistingComments(
        org,
        project,
        repoId,
        prId,
        headers
      );

      await postInlineComments(
        review,
        existing,
        org,
        project,
        repoId,
        prId,
        headers
      );

      await postSummary(
        review,
        org,
        project,
        repoId,
        prId,
        headers
      );

      console.log("Review completed");

      return new Response("done");

    } catch (e) {

      console.log("Worker error", e);

      return new Response("error", { status: 500 });
    }
  }
};



async function getAzureDiff(org, project, repoId, prId, headers) {

  // obter commits do PR
  const prUrl =
    `${org}/${project}/_apis/git/repositories/${repoId}` +
    `/pullRequests/${prId}?api-version=7.0`;

  const prRes = await fetch(prUrl, { headers });
  const pr = await prRes.json();

  const commitId = pr.lastMergeSourceCommit.commitId;

  console.log("Commit:", commitId);

  const changesUrl =
    `${org}/${project}/_apis/git/repositories/${repoId}` +
    `/commits/${commitId}/changes?api-version=7.0`;

  const changesRes = await fetch(changesUrl, { headers });
  const changes = await changesRes.json();

  let diff = "";

  for (const c of changes.changes || []) {

    const path = c.item?.path;

    if (!path) continue;

    console.log("Fetching file:", path);

    const fileUrl =
      `${org}/${project}/_apis/git/repositories/${repoId}/items` +
      `?path=${encodeURIComponent(path)}` +
      `&versionDescriptor.version=${commitId}` +
      `&versionDescriptor.versionType=commit` +
      `&includeContent=true` +
      `&api-version=7.0`;

    const fileRes = await fetch(fileUrl, { headers });

    if (fileRes.status !== 200)
      continue;

    const content = await fileRes.text();

    diff += `\nFILE: ${path}\n`;
    diff += content.substring(0, 8000);

    if (diff.length > MAX_PATCH)
      break;
  }

  return diff;
}



async function askLLM(diff, key) {

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
            role: "system",
            content:
              "You are a senior software engineer reviewing pull requests."
          },
          {
            role: "user",
            content:
              `Review these changed files.\n\n` +
              `Report bugs, security issues and performance problems.\n\n` +
              `Format:\nfile:line - issue\n\n` +
              diff
          }
        ]
      })
    }
  );

  const j = await r.json();

  return j.choices?.[0]?.message?.content || "";
}



async function getExistingComments(org, project, repoId, prId, headers) {

  const url =
    `${org}/${project}/_apis/git/repositories/${repoId}` +
    `/pullRequests/${prId}/threads?api-version=7.0`;

  const r = await fetch(url, { headers });

  const json = await r.json();

  const existing = new Set();

  for (const thread of json.value || []) {

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
  review,
  existing,
  org,
  project,
  repoId,
  prId,
  headers
) {

  const url =
    `${org}/${project}/_apis/git/repositories/${repoId}` +
    `/pullRequests/${prId}/threads?api-version=7.0`;

  const lines = review.split("\n");

  for (const l of lines) {

    if (!l.includes(":") || !l.includes("-"))
      continue;

    try {

      const [meta, text] = l.split("-", 2);

      const [file, lineStr] = meta.split(":");

      const line = parseInt(lineStr);

      const key = `${file}:${line}:${text.trim()}`;

      if (existing.has(key))
        continue;

      existing.add(key);

      const payload = {
        comments: [
          {
            parentCommentId: 0,
            content: text.trim(),
            commentType: 1
          }
        ],
        status: 1,
        threadContext: {
          filePath: file.startsWith("/") ? file : "/" + file,
          rightFileStart: { line, offset: 1 },
          rightFileEnd: { line, offset: 1 }
        }
      };

      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

    } catch (e) {
      console.log("skip line", e);
    }
  }
}



async function postSummary(
  review,
  org,
  project,
  repoId,
  prId,
  headers
) {

  const url =
    `${org}/${project}/_apis/git/repositories/${repoId}` +
    `/pullRequests/${prId}/threads?api-version=7.0`;

  const payload = {
    comments: [
      {
        parentCommentId: 0,
        content: `🤖 AI Review\n\n${review}`,
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
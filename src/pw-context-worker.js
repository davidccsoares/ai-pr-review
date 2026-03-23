/**
 * Playwright Context Worker ("The Gatherer")
 *
 * Receives component file list + PR metadata from the Gateway and:
 *   1. Identifies Angular component files
 *   2. Fetches .md documentation from the test branch
 *   3. Fetches existing test files (Actions + specs) from the test branch
 *   4. Delegates to pw-generate for AI test generation
 *   5. Delegates to pw-push for committing + pipeline + PR comment
 *
 * Also hosts the /test endpoint for manual testing.
 *
 * Subrequest budget: ~14 (POST) / ~25 (/test)
 */

import { orgUrl, azureHeaders, AZURE_API_VERSION } from "./lib/azure.js";
import { postComment } from "./lib/comments.js";
import { fetchWithTimeout } from "./lib/fetch.js";
import { PLAYWRIGHT_TEST_BRANCH } from "./lib/constants.js";

// ─── Config ──────────────────────────────────────────────────────────────────
const PLAYWRIGHT_REPO_NAME = "BindTuning.AdminApp";
const PLAYWRIGHT_TARGET_BRANCH = "refs/heads/Dev";
const PLAYWRIGHT_PROJECT = "BindTuning";
const MAX_MD_CHARS = 24000;
const MAX_COMPONENT_FILES = 10;

// The specific documentation files to fetch from the test branch
const MD_DOC_PATHS = [
  "/REPOSITORY_CONTEXT.md",
  "/PULSE_REFERENCE.md",
  "/CLAUDE.md",
];

// Cache TTL for .md docs in KV (1 hour — docs rarely change)
const DOC_CACHE_TTL = 3600;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ─── GET /test — manual trigger for standalone testing ───
    // Use ?dryRun=true to skip push, pipeline, and PR comment
    if (request.method === "GET" && url.pathname === "/test") {
      const dryRun = url.searchParams.get("dryRun") === "true";
      return handleTest(env, ctx, dryRun);
    }

    // ─── GET / — health check ───
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("pw-context worker is running", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Only POST allowed", { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Validate required fields
    if (!payload.prId || !payload.repoId || !payload.project) {
      return new Response("Missing required fields: prId, repoId, project", { status: 400 });
    }

    console.log(`(log) [PW-Context] Received request for PR #${payload.prId}`);

    // Run the generation flow non-blocking
    ctx.waitUntil(runTestGeneration(payload, env));

    return new Response("Accepted", { status: 202 });
  },
};

// ─── Test Endpoint ───────────────────────────────────────────────────────────

async function handleTest(env, ctx, dryRun = false) {
  const ORG = orgUrl(env);
  const headers = azureHeaders(env.AZURE_TOKEN);

  console.log("(log) [Test] /test endpoint hit");

  try {
    // Find the AdminApp repo
    const repoUrl = `${ORG}/${PLAYWRIGHT_PROJECT}/_apis/git/repositories/${PLAYWRIGHT_REPO_NAME}?api-version=${AZURE_API_VERSION}`;
    const repoRes = await fetchWithTimeout(repoUrl, { headers });

    let repoId = null;
    if (repoRes.ok) {
      const repoData = await repoRes.json();
      repoId = repoData.id;
      console.log(`(log) [Test] Found repo: ${PLAYWRIGHT_REPO_NAME} (${repoId})`);
    } else {
      console.log("(log) [Test] Could not fetch repo, using mock data");
    }

    // Try to find a real open PR targeting Dev
    let realPr = null;
    if (repoId) {
      const prListUrl = `${ORG}/${PLAYWRIGHT_PROJECT}/_apis/git/repositories/${repoId}/pullrequests?searchCriteria.status=active&searchCriteria.targetRefName=refs/heads/Dev&$top=1&api-version=${AZURE_API_VERSION}`;
      const prListRes = await fetchWithTimeout(prListUrl, { headers });
      if (prListRes.ok) {
        const prListData = await prListRes.json();
        realPr = (prListData.value || [])[0] || null;
        if (realPr) {
          console.log(`(log) [Test] Found real PR #${realPr.pullRequestId}: "${realPr.title}"`);
        }
      }
    }

    if (realPr && repoId) {
      // ── Use a real PR ──
      const prId = realPr.pullRequestId;
      const prTitle = realPr.title || "Test PR";
      const sourceCommit = realPr.lastMergeSourceCommit?.commitId;
      const targetCommit = realPr.lastMergeTargetCommit?.commitId;

      if (!sourceCommit || !targetCommit) {
        return new Response("Found PR but missing merge commit IDs", { status: 422 });
      }

      // Get changed files from the PR's latest iteration
      const iterUrl = `${ORG}/${PLAYWRIGHT_PROJECT}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations?api-version=${AZURE_API_VERSION}`;
      const iterRes = await fetchWithTimeout(iterUrl, { headers });
      if (!iterRes.ok) {
        return new Response(`Failed to fetch PR iterations: ${iterRes.status}`, { status: 500 });
      }
      const iterData = await iterRes.json();
      const latestIteration = Math.max(...iterData.value.map((i) => i.id));

      const changesUrl = `${ORG}/${PLAYWRIGHT_PROJECT}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations/${latestIteration}/changes?api-version=${AZURE_API_VERSION}`;
      const changesRes = await fetchWithTimeout(changesUrl, { headers });
      if (!changesRes.ok) {
        return new Response(`Failed to fetch PR changes: ${changesRes.status}`, { status: 500 });
      }
      const changesData = await changesRes.json();
      const entries = changesData.changeEntries || changesData.changes || [];

      // Build simplified file changes (fetch new file content for diffs — in parallel)
      const eligibleEntries = entries.filter(e => {
        if (!e.item?.path || e.item.path.endsWith("/")) return false;
        const ct = typeof e.changeType === "string" ? e.changeType.toLowerCase() : e.changeType;
        return ct === "edit" || ct === 2 || ct === "add" || ct === 1;
      }).slice(0, MAX_COMPONENT_FILES);

      const fileResults = await Promise.allSettled(
        eligibleEntries.map(async (e) => {
          const ct = typeof e.changeType === "string" ? e.changeType.toLowerCase() : e.changeType;
          const isAdd = ct === "add" || ct === 1;
          const fileUrl = `${ORG}/${PLAYWRIGHT_PROJECT}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(e.item.path)}&versionDescriptor.version=${sourceCommit}&versionDescriptor.versionType=commit&includeContent=true&api-version=${AZURE_API_VERSION}`;
          const fileRes = await fetchWithTimeout(fileUrl, { headers });
          if (!fileRes.ok) return null;
          const content = await fileRes.text();
          const lines = content.split("\n").slice(0, 80);
          const diff = lines.map((l, idx) => `+${idx + 1}: ${l}`).join("\n");
          return { path: e.item.path, diff, isAdd };
        })
      );

      const fileChanges = fileResults
        .filter(r => r.status === "fulfilled" && r.value !== null)
        .map(r => r.value);

      const testPayload = {
        prId,
        repoId,
        project: PLAYWRIGHT_PROJECT,
        prTitle,
        fileChanges,
        azureToken: env.AZURE_TOKEN,
        dryRun,
      };

      ctx.waitUntil(runTestGeneration(testPayload, env));

      return new Response(
        JSON.stringify({
          status: dryRun
            ? "Playwright test generation triggered (DRY RUN — no push, no pipeline, no comment)"
            : "Playwright test generation triggered",
          dryRun,
          pr: prId,
          title: prTitle,
          filesAnalyzed: fileChanges.length,
          filePaths: fileChanges.map(f => f.path),
        }, null, 2),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } else {
      // ── No real PR found — use mock data ──
      console.log("(log) [Test] No real PR found, using mock file changes");

      const mockFileChanges = [
        {
          path: "/src/app/features/dashboard/dashboard.component.ts",
          diff: "+1: import { Component } from '@angular/core';\n+2: @Component({ selector: 'app-dashboard' })\n+3: export class DashboardComponent {\n+4:   title = 'Dashboard';\n+5: }",
          isAdd: true,
        },
        {
          path: "/src/app/features/dashboard/dashboard.component.html",
          diff: "+1: <div class=\"dashboard\">\n+2:   <h1>{{ title }}</h1>\n+3:   <app-widget-grid></app-widget-grid>\n+4: </div>",
          isAdd: true,
        },
        {
          path: "/src/app/services/dashboard.service.ts",
          diff: "+1: import { Injectable } from '@angular/core';\n+2: @Injectable({ providedIn: 'root' })\n+3: export class DashboardService {\n+4:   getData() { return []; }\n+5: }",
          isAdd: true,
        },
      ];

      const testPayload = {
        prId: 99999,
        repoId: repoId || "mock-repo-id",
        project: PLAYWRIGHT_PROJECT,
        prTitle: "[TEST] Mock PR for Playwright generation",
        fileChanges: mockFileChanges,
        azureToken: env.AZURE_TOKEN,
        dryRun,
      };

      ctx.waitUntil(runTestGeneration(testPayload, env));

      return new Response(
        JSON.stringify({
          status: dryRun
            ? "Playwright test generation triggered (MOCK DATA, DRY RUN)"
            : "Playwright test generation triggered (MOCK DATA)",
          dryRun,
          note: "No real AdminApp PR targeting Dev was found. Push/pipeline will fail but AI generation will run.",
          mockFiles: mockFileChanges.map(f => f.path),
        }, null, 2),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch (e) {
    console.error("(log) [Test] Error:", e.stack || e.message);
    return new Response(`Test endpoint error: ${e.message}`, { status: 500 });
  }
}

// ─── Main Test Generation Flow ───────────────────────────────────────────────

async function runTestGeneration(payload, env) {
  const { prId, repoId, project, prTitle, fileChanges, azureToken, dryRun } = payload;
  const headers = azureHeaders(azureToken || env.AZURE_TOKEN);

  try {
    console.log(`(log) [PW-Context] Starting test generation for PR #${prId}${dryRun ? " (DRY RUN)" : ""}`);

    // 1. Identify Angular component files
    const componentFiles = identifyComponentFiles(fileChanges);
    if (componentFiles.length === 0) {
      console.log("(log) [PW-Context] No Angular component files changed, skipping");
      return;
    }
    console.log(`(log) [PW-Context] Found ${componentFiles.length} component files`);

    // 2. Fetch docs and existing test files in parallel (independent operations)
    const [mdDocs, existingFiles] = await Promise.all([
      fetchMdDocs(project, repoId, headers, env),
      fetchExistingTestFiles(project, repoId, componentFiles, headers, env),
    ]);
    console.log(`(log) [PW-Context] Fetched ${mdDocs.length} .md documentation files`);
    console.log(`(log) [PW-Context] Found ${existingFiles.length} existing test file(s) on the test branch`);

    // 3. Call pw-generate worker via Service Binding (does NOT count as a subrequest!)
    console.log(`(log) [PW-Context] Delegating AI generation to pw-generate worker`);
    let generatedTests = null;
    try {
      const genRes = await env.PW_GENERATE.fetch("https://pw-generate/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          componentFiles,
          mdDocs,
          existingFiles,
          prTitle,
        }),
      });

      if (genRes.ok) {
        const genData = await genRes.json();
        if (genData.success && Array.isArray(genData.tests) && genData.tests.length > 0) {
          generatedTests = genData.tests;
        } else {
          console.log(`(log) [PW-Context] pw-generate returned no tests: ${genData.error || "empty array"}`);
        }
      } else {
        console.error(`(log) [PW-Context] pw-generate responded with ${genRes.status}`);
      }
    } catch (genErr) {
      console.error("(log) [PW-Context] pw-generate call failed:", genErr.message);
    }
    if (!generatedTests || generatedTests.length === 0) {
      console.log("(log) [PW-Context] AI generated no tests");
      if (!dryRun) {
        await postComment(env, project, repoId, prId, headers,
          `## 🎭 Playwright Test Generation\n\n⚠️ AI could not generate tests for the changed components.\n\n### Changed Components Analyzed\n${componentFiles.map(f => "- \`" + f.path + "\`").join("\n")}\n\n---\n_Generated by AI PR Review Bot — Playwright Test Gen_`,
          "PW-Context");
      }
      return;
    }
    console.log(`(log) [PW-Context] AI generated ${generatedTests.length} test files`);

    // ── Dry run: log results and stop ──
    if (dryRun) {
      console.log("(log) [PW-Context] DRY RUN — skipping push, pipeline, and PR comment");
      const existingSpecPaths = new Set(existingFiles.map(ef => ef.path.replace(/^\//, "").toLowerCase()));
      for (const t of generatedTests) {
        const action = existingSpecPaths.has(t.filePath.toLowerCase()) ? "update" : "create";
        console.log(`(log) [PW-Context] [DRY RUN] Would ${action}: ${t.filePath} (${t.content.length} chars)`);
        console.log(`(log) [PW-Context] [DRY RUN] Preview:\n${t.content.substring(0, 500)}`);
      }
      console.log(`(log) [PW-Context] DRY RUN complete for PR #${prId}`);
      return;
    }

    // 4. Delegate push + pipeline + PR comment to pw-push via Service Binding (no subrequest!)
    console.log(`(log) [PW-Context] Delegating ${generatedTests.length} test file(s) to pw-push worker`);
    try {
      const pushRes = await env.PW_PUSH.fetch("https://pw-push/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          repoId,
          prId,
          generatedTests,
          componentFiles,
          docsCount: mdDocs.length,
          azureToken: azureToken || env.AZURE_TOKEN,
        }),
      });
      console.log(`(log) [PW-Context] pw-push responded: ${pushRes.status}`);
    } catch (pushErr) {
      console.error("(log) [PW-Context] pw-push call failed:", pushErr.message);
      // Fallback: post an error comment directly
      await postComment(env, project, repoId, prId, headers,
        `## 🎭 Playwright Test Generation\n\n⚠️ Tests were generated but push worker is unreachable.\n\`${pushErr.message}\`\n\n---\n_Generated by AI PR Review Bot — Playwright Test Gen_`,
        "PW-Context");
    }

    console.log(`(log) [PW-Context] Test generation flow completed for PR #${prId}`);
  } catch (e) {
    console.error("(log) [PW-Context] Flow error:", e.stack || e.message);
    // Try to post an error comment (skip if dry run)
    if (!dryRun) {
      try {
        await postComment(env, project, repoId, prId, headers,
          `## 🎭 Playwright Test Generation\n\n❌ An error occurred during test generation:\n\`${e.message}\`\n\n---\n_Generated by AI PR Review Bot — Playwright Test Gen_`,
          "PW-Context");
      } catch (commentErr) {
        console.error("(log) [PW-Context] Could not post error comment:", commentErr.message);
      }
    }
  }
}

// ─── Step 1: Identify Angular Component Files ────────────────────────────────

function identifyComponentFiles(fileChanges) {
  const componentPatterns = /\.(component\.ts|component\.html|service\.ts|guard\.ts|interceptor\.ts|resolver\.ts|directive\.ts|pipe\.ts|module\.ts|routing\.ts)$/i;
  return fileChanges
    .filter(fc => componentPatterns.test(fc.path))
    .map(fc => {
      const pathParts = fc.path.split("/");
      const fileName = pathParts[pathParts.length - 1];
      const stem = fileName.replace(/\.(component|service|guard|interceptor|resolver|directive|pipe|module|routing)\.(ts|html)$/i, "");
      return {
        path: fc.path,
        stem,
        diff: fc.diff,
        isAdd: fc.isAdd,
      };
    });
}

// ─── Step 2: Fetch .md Documentation from Test Branch ────────────────────────

async function fetchMdDocs(project, repoId, headers, env) {
  const ORG = orgUrl(env);
  console.log(`(log) [PW-Context] Fetching ${MD_DOC_PATHS.length} doc files from branch: ${PLAYWRIGHT_TEST_BRANCH}`);

  const results = await Promise.allSettled(
    MD_DOC_PATHS.map(async (docPath) => {
      // Try KV cache first
      if (env?.BOT_KV) {
        try {
          const cacheKey = `doc:${docPath}`;
          const cached = await env.BOT_KV.get(cacheKey);
          if (cached) {
            console.log(`(log) [PW-Context] Cache HIT: ${docPath} (${cached.length} chars)`);
            return { path: docPath, content: cached };
          }
          console.log(`(log) [PW-Context] Cache MISS: ${docPath}`);
        } catch (kvErr) {
          console.log(`(log) [PW-Context] KV read error for ${docPath}:`, kvErr.message);
        }
      }

      // Cache miss or KV unavailable — fetch from Azure
      const contentUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(docPath)}&versionDescriptor.version=${encodeURIComponent(PLAYWRIGHT_TEST_BRANCH)}&versionDescriptor.versionType=branch&includeContent=true&api-version=${AZURE_API_VERSION}`;
      const contentRes = await fetchWithTimeout(contentUrl, { headers });
      if (!contentRes.ok) {
        console.log(`(log) [PW-Context] Could not fetch ${docPath}: ${contentRes.status}`);
        return null;
      }
      let content = await contentRes.text();
      if (content.length > MAX_MD_CHARS) {
        content = content.substring(0, MAX_MD_CHARS) + "\n...(truncated)";
      }
      console.log(`(log) [PW-Context] Fetched: ${docPath} (${content.length} chars)`);

      // Write to KV cache (fire-and-forget)
      if (env?.BOT_KV) {
        try {
          await env.BOT_KV.put(`doc:${docPath}`, content, { expirationTtl: DOC_CACHE_TTL });
          console.log(`(log) [PW-Context] Cached: ${docPath} (TTL ${DOC_CACHE_TTL}s)`);
        } catch (kvErr) {
          console.log(`(log) [PW-Context] KV write error for ${docPath}:`, kvErr.message);
        }
      }

      return { path: docPath, content };
    })
  );

  return results
    .filter(r => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value);
}

// ─── Step 2b: Fetch Existing Test Files from Test Branch ─────────────────────

async function fetchExistingTestFiles(project, repoId, componentFiles, headers, env) {
  const ORG = orgUrl(env);
  // Paths to check: always fetch actionsFixture.ts
  const pathsToCheck = ["/tests/fixtures/actionsFixture.ts"];

  // For each component stem, check if Actions and spec files already exist
  const stems = [...new Set(componentFiles.map(f => f.stem))];
  for (const stem of stems) {
    pathsToCheck.push(`/tests/components/${stem}/${stem}Actions.ts`);
    pathsToCheck.push(`/tests/components/${stem}/${stem}.spec.ts`);
  }

  const results = await Promise.allSettled(
    pathsToCheck.map(async (filePath) => {
      const contentUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(filePath)}&versionDescriptor.version=${encodeURIComponent(PLAYWRIGHT_TEST_BRANCH)}&versionDescriptor.versionType=branch&includeContent=true&api-version=${AZURE_API_VERSION}`;
      const contentRes = await fetchWithTimeout(contentUrl, { headers });
      if (!contentRes.ok) return null;
      const fullContent = await contentRes.text();

      // For the AI prompt, truncate to save tokens — but keep full content for merge operations
      let promptContent = fullContent;
      if (promptContent.length > 4000) {
        promptContent = promptContent.substring(0, 4000) + "\n...(truncated)";
      }
      console.log(`(log) [PW-Context] Existing file found: ${filePath} (${fullContent.length} chars)`);
      return { path: filePath, content: promptContent, fullContent };
    })
  );

  return results
    .filter(r => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value);
}

const ORG = "https://dev.azure.com/bindtuning";
const AZURE_API_VERSION = "7.0";
const CF_AI_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";

// ─── Playwright Test Generation Config ───────────────────────────────────────
const PLAYWRIGHT_REPO_NAME = "BindTuning.AdminApp";
const PLAYWRIGHT_TARGET_BRANCH = "refs/heads/Dev";
const PLAYWRIGHT_PROJECT = "BindTuning";
const PLAYWRIGHT_TEST_BRANCH = "internship/playwright-unit-tests";
const PIPELINE_ID = 88;
const MAX_MD_CHARS = 24000;
// Cloudflare free plan: 50 subrequests per invocation.
// /test endpoint worst case: ~38 subrequests (repo + PR + iterations + changes + 15 file contents + test gen flow).
// POST endpoint worst case: ~19 subrequests (3 docs + 7 existing checks + AI + push flow + pipeline + comment).
// Keep file limits conservative to stay under the cap.
const MAX_COMPONENT_FILES = 10;  // Max changed files to analyze (was 15 — reduced for subrequest safety)

// The specific documentation files to fetch from the test branch
const MD_DOC_PATHS = [
  "/REPOSITORY_CONTEXT.md",
  "/PULSE_REFERENCE.md",
  "/CLAUDE.md",
];

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
      return new Response("playwright-test-gen worker is running", { status: 200 });
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

    console.log(`(log) [Playwright] Received request for PR #${payload.prId}`);

    // Run the generation flow non-blocking
    ctx.waitUntil(runTestGeneration(payload, env));

    return new Response("Accepted", { status: 202 });
  },
};

// ─── Test Endpoint ───────────────────────────────────────────────────────────

/**
 * GET /test
 * GET /test?dryRun=true
 *
 * Fetches the latest open PR on AdminApp targeting Dev, gathers diffs,
 * and runs the full Playwright test generation flow. If no PR is found,
 * uses mock data (AI generation works, but push/pipeline will fail).
 *
 * With ?dryRun=true: fetches docs, generates tests via AI, but does NOT
 * push to branch, trigger pipeline, or post a PR comment. Returns the
 * generated tests in the response instead.
 */
async function handleTest(env, ctx, dryRun = false) {
  const azureHeaders = {
    Authorization: `Basic ${btoa(":" + env.AZURE_TOKEN)}`,
  };

  console.log("(log) [Test] /test endpoint hit");

  try {
    // Find the AdminApp repo
    const repoUrl = `${ORG}/${PLAYWRIGHT_PROJECT}/_apis/git/repositories/${PLAYWRIGHT_REPO_NAME}?api-version=${AZURE_API_VERSION}`;
    const repoRes = await fetch(repoUrl, { headers: azureHeaders });

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
      const prListRes = await fetch(prListUrl, { headers: azureHeaders });
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
      const iterRes = await fetch(iterUrl, { headers: azureHeaders });
      if (!iterRes.ok) {
        return new Response(`Failed to fetch PR iterations: ${iterRes.status}`, { status: 500 });
      }
      const iterData = await iterRes.json();
      const latestIteration = Math.max(...iterData.value.map((i) => i.id));

      const changesUrl = `${ORG}/${PLAYWRIGHT_PROJECT}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations/${latestIteration}/changes?api-version=${AZURE_API_VERSION}`;
      const changesRes = await fetch(changesUrl, { headers: azureHeaders });
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
          const fileRes = await fetch(fileUrl, { headers: azureHeaders });
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
  const azureHeaders = {
    Authorization: `Basic ${btoa(":" + (azureToken || env.AZURE_TOKEN))}`,
  };

  try {
    console.log(`(log) [Playwright] Starting test generation for PR #${prId}${dryRun ? " (DRY RUN)" : ""}`);

    // 1. Identify Angular component files
    const componentFiles = identifyComponentFiles(fileChanges);
    if (componentFiles.length === 0) {
      console.log("(log) [Playwright] No Angular component files changed, skipping");
      return;
    }
    console.log(`(log) [Playwright] Found ${componentFiles.length} component files`);

    // 2. Fetch docs and existing test files in parallel (independent operations)
    const [mdDocs, existingFiles] = await Promise.all([
      fetchMdDocs(project, repoId, azureHeaders),
      fetchExistingTestFiles(project, repoId, componentFiles, azureHeaders),
    ]);
    console.log(`(log) [Playwright] Fetched ${mdDocs.length} .md documentation files`);
    console.log(`(log) [Playwright] Found ${existingFiles.length} existing test file(s) on the test branch`);

    // 3. Call AI to generate actual test files
    const generatedTests = await generateTests(componentFiles, mdDocs, existingFiles, prTitle, env);
    if (!generatedTests || generatedTests.length === 0) {
      console.log("(log) [Playwright] AI generated no tests");
      if (!dryRun) {
        await postComment(project, repoId, prId, azureHeaders,
          buildComment([], componentFiles, mdDocs.length, "AI could not generate tests for the changed components."));
      }
      return;
    }
    console.log(`(log) [Playwright] AI generated ${generatedTests.length} test files`);

    // ── Dry run: log results and stop ──
    if (dryRun) {
      console.log("(log) [Playwright] DRY RUN — skipping push, pipeline, and PR comment");
      const existingSpecPaths = new Set(existingFiles.map(ef => ef.path.replace(/^\//, "").toLowerCase()));
      for (const t of generatedTests) {
        const action = existingSpecPaths.has(t.filePath.toLowerCase()) ? "update" : "create";
        console.log(`(log) [Playwright] [DRY RUN] Would ${action}: ${t.filePath} (${t.content.length} chars)`);
        console.log(`(log) [Playwright] [DRY RUN] Preview:\n${t.content.substring(0, 500)}`);
      }
      console.log(`(log) [Playwright] DRY RUN complete for PR #${prId}`);
      return;
    }

    // 4. Push generated tests to the test branch
    const pushResult = await pushTests(project, repoId, generatedTests, prId, azureHeaders);
    console.log(`(log) [Playwright] Push result: ${pushResult.success ? "success" : "failed"}`);

    // 5. Trigger pipeline 88
    let pipelineTriggered = false;
    if (pushResult.success) {
      pipelineTriggered = await triggerPipeline(project, azureHeaders);
      console.log(`(log) [Playwright] Pipeline trigger: ${pipelineTriggered ? "success" : "failed"}`);
    }

    // 6. Post PR comment with summary
    const comment = buildComment(generatedTests, componentFiles, mdDocs.length,
      null, pushResult.success, pipelineTriggered);
    await postComment(project, repoId, prId, azureHeaders, comment);

    console.log(`(log) [Playwright] Test generation flow completed for PR #${prId}`);
  } catch (e) {
    console.error("(log) [Playwright] Flow error:", e.stack || e.message);
    // Try to post an error comment (skip if dry run)
    if (!dryRun) {
      try {
        await postComment(project, repoId, prId, azureHeaders,
          `## 🎭 Playwright Test Generation\n\n❌ An error occurred during test generation:\n\`${e.message}\`\n\n---\n_Generated by AI PR Review Bot — Playwright Test Gen_`);
      } catch (commentErr) {
        console.error("(log) [Playwright] Could not post error comment:", commentErr.message);
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

/**
 * Fetch documentation files from the test branch (parallelized).
 * Subrequests: 1 per file = 3 total (run concurrently).
 */
async function fetchMdDocs(project, repoId, azureHeaders) {
  console.log(`(log) [Playwright] Fetching ${MD_DOC_PATHS.length} doc files from branch: ${PLAYWRIGHT_TEST_BRANCH}`);

  const results = await Promise.allSettled(
    MD_DOC_PATHS.map(async (docPath) => {
      const contentUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(docPath)}&versionDescriptor.version=${encodeURIComponent(PLAYWRIGHT_TEST_BRANCH)}&versionDescriptor.versionType=branch&includeContent=true&api-version=${AZURE_API_VERSION}`;
      const contentRes = await fetch(contentUrl, { headers: azureHeaders });
      if (!contentRes.ok) {
        console.log(`(log) [Playwright] Could not fetch ${docPath}: ${contentRes.status}`);
        return null;
      }
      let content = await contentRes.text();
      if (content.length > MAX_MD_CHARS) {
        content = content.substring(0, MAX_MD_CHARS) + "\n...(truncated)";
      }
      console.log(`(log) [Playwright] Fetched: ${docPath} (${content.length} chars)`);
      return { path: docPath, content };
    })
  );

  return results
    .filter(r => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value);
}

// ─── Step 2b: Fetch Existing Test Files from Test Branch ─────────────────────

/**
 * Check the test branch for:
 * 1. tests/fixtures/actionsFixture.ts — to know which Actions classes are already registered
 * 2. Existing *Actions.ts and *.spec.ts files for the changed component stems
 *
 * Returns an array of { path, content } for files that exist.
 */
async function fetchExistingTestFiles(project, repoId, componentFiles, azureHeaders) {
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
      const contentRes = await fetch(contentUrl, { headers: azureHeaders });
      if (!contentRes.ok) return null;
      const fullContent = await contentRes.text();

      // For the AI prompt, truncate to save tokens — but keep full content for merge operations
      let promptContent = fullContent;
      if (promptContent.length > 4000) {
        promptContent = promptContent.substring(0, 4000) + "\n...(truncated)";
      }
      console.log(`(log) [Playwright] Existing file found: ${filePath} (${fullContent.length} chars)`);
      return { path: filePath, content: promptContent, fullContent };
    })
  );

  return results
    .filter(r => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value);
}

// ─── Step 3: AI Test Generation ──────────────────────────────────────────────

/**
 * Call AI with the .md docs + component diffs to generate actual runnable
 * Playwright test files.
 *
 * Returns an array of { filePath, content } or null on failure.
 */
async function generateTests(componentFiles, mdDocs, existingFiles, prTitle, env) {
  // Build documentation context
  let docsContext = "";
  if (mdDocs.length > 0) {
    docsContext = "\n## Project Documentation (from test branch)\n\n";
    for (const doc of mdDocs) {
      docsContext += `### ${doc.path}\n\`\`\`markdown\n${doc.content}\n\`\`\`\n\n`;
    }
  }

  // Build existing test files context — send compact summaries to save tokens
  let existingContext = "";
  if (existingFiles.length > 0) {
    existingContext = "\n## Existing Test Files (already on the test branch)\n\n";
    existingContext += "These files ALREADY EXIST. Do NOT regenerate them. Reuse their classes and imports.\n\n";
    for (const ef of existingFiles) {
      const source = ef.fullContent || ef.content;
      if (ef.path.includes("actionsFixture")) {
        // For the fixture, just show the type signature (what actions are available)
        existingContext += `### ${ef.path}\nThis fixture provides these action objects: ${extractFixtureActions(source).join(", ")}\n\n`;
      } else if (/Actions\.ts$/i.test(ef.path)) {
        // For Actions files, extract method signatures instead of sending full source
        const methods = extractMethodSignatures(source);
        existingContext += `### ${ef.path}\nClass with these methods:\n${methods.map(m => "- " + m).join("\n")}\n\n`;
      } else {
        // For spec files, show test names so the AI knows what already exists
        const testNames = extractTestNames(source);
        existingContext += `### ${ef.path}\nExisting tests:\n${testNames.map(n => "- " + n).join("\n")}\n\n`;
      }
    }
  }

  // Build component diffs
  const filesDescription = componentFiles.map(f =>
    `### ${f.path} (${f.isAdd ? "new" : "edited"})\n\`\`\`\n${f.diff}\n\`\`\``
  ).join("\n\n");

  const systemPrompt = `You are a senior QA engineer generating Playwright E2E tests for the BindTuning AdminApp — an Angular-based web administration application.

${docsContext}
${existingContext}

You MUST follow the patterns, imports, constants, and conventions described in the documentation above.

─── CRITICAL IMPORT RULES ───────────────────────────────────────────────────
- ALWAYS import \`test\` (and optionally \`expect\`) from the custom fixture:
    import { test, expect } from '../../fixtures/actionsFixture';
  NEVER import \`test\` from '@playwright/test'. The custom fixture provides the \`actions\` object with all page-object classes.
- If you need \`expect\` alone (rare), you may import it from '@playwright/test', but \`test\` MUST come from actionsFixture.
- Import route constants from the constants module:
    import { ROUTES } from '../../constants';
- Import URL helpers when building full URLs:
    import { withBase } from '../../utils/envUrls';
- Import skip helpers when tests require a specific user persona:
    import { skipIfNotProject } from '../../helpers/helpers';
- Import icon constants when validating icons:
    import { PLATFORM_ICONS, STATUS_ICONS, ACTION_ICONS } from '../../constants';
- Import timeout constants instead of hardcoding numbers:
    import { TIMEOUTS } from '../../constants';

─── PAGE OBJECT MODEL (ACTIONS CLASSES) ─────────────────────────────────────
- All tests use the \`actions\` fixture which provides domain-specific page objects:
    actions.pulse, actions.dashboard, actions.workspaces, actions.automations,
    actions.approvals, actions.catalog, actions.connections, actions.homepage,
    actions.templates, actions.policies, actions.themes, actions.user,
    actions.webparts, actions.buttons
- Each Actions class extends BaseActions (tests/base/BaseActions.ts) which provides:
    navigateTo(route), waitForPageLoad(), waitForTableData(timeout?),
    waitForTableOrEmpty(timeout?), clickByIcon(iconName), getTableDataRows(timeout?),
    getTableRowCount(), hasTableData(), searchBar(name, query, expected)

─── EXISTING FILES AWARENESS (CRITICAL) ────────────────────────────────────
- Check the "Existing Test Files" section above BEFORE generating anything.
- If actionsFixture.ts is provided, look at it to see which Actions classes are ALREADY registered.
  If the feature's Actions class is already in the fixture (e.g., \`dashboard: new DashboardActions(page)\`),
  then in the spec file use it directly via \`actions.dashboard\` — do NOT generate a new Actions file and
  do NOT instantiate the class manually.
- If a *Actions.ts file already exists for the component, do NOT regenerate it.
  Only generate the spec file and import/use the existing Actions class.
- If a *.spec.ts file already exists for the component, ADD new tests to complement it — do NOT duplicate
  tests that already exist. Generate the file with ONLY the new tests that cover the PR changes.
- ONLY generate a new *Actions.ts file if NO existing one covers the changed component.
  In that case, also generate the spec file and instantiate the class directly:
    const featureActions = new FeatureActions(page);
  The new Actions file must follow this pattern:
    import { Page, expect } from '@playwright/test';
    import { BaseActions } from '../../base/BaseActions';
    import { ROUTES } from '../../constants';
    export class FeatureActions extends BaseActions {
      constructor(page: Page) { super(page); }
      async goToFeature() { await this.navigateTo(ROUTES.FEATURE_ROUTE); await this.waitForTableData(); }
    }

─── TEST STRUCTURE & CONVENTIONS ────────────────────────────────────────────
- Use test.describe blocks with a @Tag in the description for grouping.
- Apply tags to both describe blocks and individual tests:
    test.describe('Feature Name @FeatureTag', () => {
      test('should do something @FeatureTag @ActionTag', async ({ actions }) => { ... });
    });
- Use test.beforeEach for common navigation/setup.
- Use test.step for multi-step workflows inside a single test.
- Use data-driven patterns (for...of loops) for repetitive test cases.
- Destructure \`{ actions }\` (or \`{ actions, page }\`, \`{ actions, Sort }\`, etc.) from the test function parameter.

─── FILE PATH CONVENTIONS ───────────────────────────────────────────────────
- Spec files: tests/components/<feature>/<featureName>.spec.ts
- Actions files: tests/components/<feature>/<featureName>Actions.ts
- For Pulse sub-features: tests/components/pulse/<subFeature>.spec.ts
- Match the existing directory structure from the documentation.

─── AVAILABLE ROUTE CONSTANTS (use ROUTES.<name>) ──────────────────────────
Main: HOME, CATALOG
Pulse: PULSE_OVERVIEW, PULSE_POLICIES, PULSE_INTEGRITY_SCORE,
       PULSE_WORKSPACES_ALL, PULSE_WORKSPACES_TEAMS, PULSE_WORKSPACES_SHAREPOINT,
       PULSE_ACTIVITY_ACTIVE, PULSE_ACTIVITY_DELETED,
       PULSE_STORAGE_SHAREPOINT, PULSE_STORAGE_ONEDRIVE
Automate: AUTOMATE_DASHBOARD_OVERVIEW, AUTOMATE_TEMPLATES, AUTOMATIONS_LIST
Settings: WORKSPACE_GENERAL, PROFILE_ACCOUNT
Intranet: THEMES, WEBPARTS

─── OUTPUT FORMAT ───────────────────────────────────────────────────────────
Respond with ONLY a raw JSON array, no markdown, no code fences.

If the spec file DOES NOT exist yet, return a complete file:
[{"filePath": "tests/components/feature/feature.spec.ts", "content": "import { test, expect } from '../../fixtures/actionsFixture';\\n...full file..."}]

If the spec file ALREADY EXISTS (shown in "Existing Test Files"), return ONLY the new test() blocks
to be appended inside the existing describe block. Do NOT include imports, do NOT include test.describe,
do NOT include test.beforeEach — just the raw test() calls:
[{"filePath": "tests/components/feature/feature.spec.ts", "appendOnly": true, "content": "  test('should do new thing @Tag', async ({ actions }) => {\\n    ...\\n  });\\n\\n  test('should do other new thing @Tag', async ({ actions }) => {\\n    ...\\n  });"}]

If you also generate a NEW Actions file, include it as a separate entry:
[{"filePath": "tests/components/feature/featureActions.ts", "content": "..."}, {"filePath": "...spec.ts", ...}]

If the spec already exists AND the PR changes don't warrant new tests, return an empty array: []

─── RULES ───────────────────────────────────────────────────────────────────
1. Generate one spec file per logical component/feature changed.
2. Check the "Existing Test Files" section FIRST:
   - If the Actions class is already in actionsFixture.ts, use \`actions.<name>\` — do NOT regenerate the Actions file.
   - If the Actions file exists but is NOT in the fixture, import it directly and instantiate with \`new\`.
   - If the spec file already exists, set "appendOnly": true and return ONLY new test() blocks — no imports, no describe, no beforeEach.
   - If the spec exists and the PR changes are already covered by existing tests, return an empty array [].
   - Only generate a new Actions file when none exists for the feature.
3. Each test file must be a valid, runnable Playwright test using the actionsFixture.
4. Include meaningful test descriptions that explain what is being tested.
5. Cover: navigation, user interactions (click, fill, select), expected outcomes (visible elements, URL changes, text content).
6. Include edge cases where appropriate (empty states, error states, loading states).
7. Use descriptive test names: "should [expected behavior] when [condition]".
8. Keep tests focused and atomic — one assertion concept per test.
9. Use TIMEOUTS constants instead of hardcoded timeout numbers.
10. Use withBase() for full URL assertions; use ROUTES constants for navigation.
11. For Pulse features, prefer the rich PulseActions methods (filterByType, filterByCard, goToPulse, redirectToGeneric, etc.) documented in PULSE_REFERENCE.md.
12. Do NOT generate tests for trivial template-only changes (e.g., whitespace, comments).
13. Do NOT import \`test\` from '@playwright/test' — ALWAYS use the actionsFixture import.
14. Include @Tags on describe blocks and test names following the project tagging system.`;

  const userPrompt = `PR: "${prTitle}"

Generate Playwright test files for the following changed components:

${filesDescription}`;

  try {
    console.log("(log) [Playwright] Generating tests for", componentFiles.length, "files with", mdDocs.length, "docs");

    const aiResponse = await env.AI.run(CF_AI_MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4096,
    });

    const raw = aiResponse?.response;
    const rawStr = typeof raw === "string" ? raw.trim() : JSON.stringify(raw);
    console.log("(log) [Playwright] AI response length:", rawStr?.length ?? 0);

    // Parse the JSON array from the AI response
    let tests;
    if (Array.isArray(raw)) {
      tests = raw;
    } else if (typeof raw === "string") {
      // Strip markdown code fences if present (```json ... ```)
      let cleaned = raw.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");

      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const jsonStr = jsonMatch[0];

        // Try parsing as-is first (works if AI returned well-formed JSON)
        try {
          tests = JSON.parse(jsonStr);
        } catch (_e1) {
          // If direct parse fails, sanitize control characters INSIDE string values only.
          // Walk through the JSON and only escape newlines/tabs that are inside quoted strings.
          try {
            const sanitized = sanitizeJsonStringValues(jsonStr);
            tests = JSON.parse(sanitized);
          } catch (e2) {
            console.error("(log) [Playwright] JSON parse failed after sanitization:", e2.message);
            console.log("(log) [Playwright] Raw AI response (first 500 chars):", rawStr?.substring(0, 500));
            tests = null;
          }
        }
      } else {
        tests = null;
      }
    } else {
      tests = null;
    }

    if (!Array.isArray(tests) || tests.length === 0) {
      console.log("(log) [Playwright] AI did not return valid test array");
      return null;
    }

    // Build a set of existing file paths (normalized) for dedup filtering
    const existingPaths = new Set(
      existingFiles.map(ef => ef.path.replace(/^\//, "").toLowerCase())
    );

    // Extract registered action names from actionsFixture.ts (e.g., "dashboard", "pulse", "workspaces")
    const fixtureFile = existingFiles.find(ef => ef.path.includes("actionsFixture"));
    const registeredActions = new Set();
    if (fixtureFile) {
      // Use fullContent (not truncated) so we can find all registered actions
      const fixtureSource = fixtureFile.fullContent || fixtureFile.content;
      const actionMatches = fixtureSource.matchAll(/(\w+):\s*new\s+\w+Actions\(page\)/g);
      for (const m of actionMatches) {
        registeredActions.add(m[1].toLowerCase());
      }
      console.log(`(log) [Playwright] Registered fixture actions: ${[...registeredActions].join(", ")}`);
    }

    // Validate each test has required fields and post-process common AI mistakes
    return tests.filter(t => t.filePath && t.content).map(t => {
      let filePath = t.filePath.replace(/^\//, ""); // strip leading slash
      const isAppendOnly = !!t.appendOnly;

      // Ensure spec files live under tests/components/ (fix flat paths like "tests/dashboard.spec.ts")
      if (filePath.match(/^tests\/[^/]+\.spec\.ts$/) && !filePath.startsWith("tests/components/")) {
        const name = filePath.replace("tests/", "").replace(".spec.ts", "");
        filePath = `tests/components/${name}/${name}.spec.ts`;
      }

      let content = t.content;

      // ── Handle existing spec files: merge new tests into existing content ──
      const existingSpec = existingFiles.find(
        ef => ef.path.replace(/^\//, "").toLowerCase() === filePath.toLowerCase()
      );
      if (existingSpec && filePath.endsWith(".spec.ts")) {
        // Use the FULL content for merge — not the truncated version sent to the AI
        const existingFull = existingSpec.fullContent || existingSpec.content;

        if (isAppendOnly) {
          // AI returned only new test() blocks — inject them before the closing of the last describe
          console.log(`(log) [Playwright] Appending new tests into existing ${filePath}`);
          const lastClose = existingFull.lastIndexOf("});");
          if (lastClose !== -1) {
            content = existingFull.substring(0, lastClose) + "\n" + content.trim() + "\n\n" + existingFull.substring(lastClose);
          } else {
            // Fallback: just append
            content = existingFull + "\n\n" + content;
          }
        } else {
          // AI ignored appendOnly and returned a full file — extract just the test() blocks
          // and merge them into the existing file
          console.log(`(log) [Playwright] AI returned full file for existing spec — extracting new tests only`);
          const newTestBlocks = extractTestBlocks(content);
          const existingTestNames = extractTestNames(existingFull);
          // Filter to only genuinely new tests
          const uniqueNewTests = newTestBlocks.filter(
            block => !existingTestNames.some(name => block.includes(name))
          );
          if (uniqueNewTests.length === 0) {
            console.log(`(log) [Playwright] No new tests to add to ${filePath} — all already exist`);
            content = null; // Mark for removal
          } else {
            console.log(`(log) [Playwright] Merging ${uniqueNewTests.length} new test(s) into existing ${filePath}`);
            const lastClose = existingFull.lastIndexOf("});");
            if (lastClose !== -1) {
              content = existingFull.substring(0, lastClose) + "\n" + uniqueNewTests.join("\n\n") + "\n\n" + existingFull.substring(lastClose);
            } else {
              content = existingFull + "\n\n" + uniqueNewTests.join("\n\n");
            }
          }
        }
        // Skip further import/fixture rewrites — we're using the existing file's imports
        if (content) {
          return { filePath, content };
        }
        return { filePath, content: null };
      }

      // ── Non-existing spec files: apply standard post-processing ──

      // Fix wrong import: replace '@playwright/test' test import with actionsFixture
      content = content.replace(
        /import\s*\{\s*test\s*,\s*expect\s*\}\s*from\s*['"]@playwright\/test['"]/g,
        "import { test, expect } from '../../fixtures/actionsFixture'"
      );
      content = content.replace(
        /import\s*\{\s*test\s*\}\s*from\s*['"]@playwright\/test['"]/g,
        "import { test } from '../../fixtures/actionsFixture'"
      );

      // If the spec manually instantiates an Actions class that is already in the fixture,
      // rewrite to use the fixture's `actions.<name>` instead
      if (filePath.endsWith(".spec.ts") && registeredActions.size > 0) {
        const manualInstMatch = content.match(/new\s+(\w+)Actions\(page\)/);
        if (manualInstMatch) {
          const className = manualInstMatch[1];
          const fixtureKey = className.charAt(0).toLowerCase() + className.slice(1);
          if (registeredActions.has(fixtureKey.toLowerCase())) {
            console.log(`(log) [Playwright] Post-fix: ${className}Actions is in fixture as actions.${fixtureKey} — rewriting spec to use fixture`);
            content = content.replace(
              new RegExp(`import\\s*\\{\\s*${className}Actions\\s*\\}\\s*from\\s*['"][^'"]+['"];?\\n?`, "g"),
              ""
            );
            const varName = fixtureKey + "Actions";
            content = content.replace(
              new RegExp(`\\s*(let|const)\\s+${varName}\\s*[:=][^;]*;?\\n?`, "gi"),
              "\n"
            );
            content = content.replace(
              new RegExp(`\\s*${varName}\\s*=\\s*new\\s+${className}Actions\\(page\\);?\\n?`, "gi"),
              "\n"
            );
            content = content.replace(
              new RegExp(`${varName}\\.`, "g"),
              `actions.${fixtureKey}.`
            );
            content = content.replace(
              /async\s*\(\{\s*\}\)/g,
              "async ({ actions })"
            );
            content = content.replace(
              /async\s*\(\{\s*page\s*\}\)/g,
              "async ({ actions, page })"
            );
          }
        }
      }

      return { filePath, content };
    }).filter(t => {
      // Drop entries with null content (no new tests to add)
      if (!t.content) return false;
      // Drop Actions files the AI regenerated when they already exist on the test branch
      const isActionsFile = /Actions\.ts$/i.test(t.filePath);
      if (isActionsFile && existingPaths.has(t.filePath.toLowerCase())) {
        console.log(`(log) [Playwright] Skipping ${t.filePath} — already exists on test branch`);
        return false;
      }
      return true;
    });
  } catch (e) {
    console.error("(log) [Playwright] AI test generation failed:", e.message);
    return null;
  }
}

// ─── Helpers: Extract test blocks and names from spec file content ───────────

/**
 * Extract method signatures from an Actions class file.
 * Returns array of strings like "async goToDashboard()" or "async goToTab(tabName: string, buttonName: string)"
 */
function extractMethodSignatures(content) {
  const methods = [];
  const methodPattern = /async\s+(\w+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = methodPattern.exec(content)) !== null) {
    const name = match[1];
    const params = match[2].trim();
    // Skip constructor
    if (name === "constructor") continue;
    methods.push(`async ${name}(${params})`);
  }
  return methods;
}

/**
 * Extract registered action names from the actionsFixture.ts file.
 * Returns array of strings like "actions.pulse", "actions.dashboard", etc.
 */
function extractFixtureActions(content) {
  const actions = [];
  const pattern = /(\w+):\s*new\s+\w+Actions\(page\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    actions.push(`actions.${match[1]}`);
  }
  return actions;
}

/**
 * Extract individual test() blocks from a spec file string.
 * Returns an array of strings, each being a complete test(...) block.
 */
function extractTestBlocks(content) {
  const blocks = [];
  const testPattern = /^[ \t]*test\s*\(/gm;
  let match;
  while ((match = testPattern.exec(content)) !== null) {
    // Find the matching closing brace by counting braces
    let depth = 0;
    let started = false;
    let end = match.index;
    for (let i = match.index; i < content.length; i++) {
      if (content[i] === "{") { depth++; started = true; }
      if (content[i] === "}") { depth--; }
      if (started && depth === 0) {
        // Include the closing ");""
        end = Math.min(i + 3, content.length); // });
        break;
      }
    }
    blocks.push(content.substring(match.index, end).trim());
  }
  return blocks;
}

/**
 * Extract test names (the string inside test('...',)) from a spec file.
 * Returns an array of test name strings.
 */
/**
 * Sanitize control characters (newlines, tabs) ONLY inside JSON string values.
 * Walks the string character by character, tracking whether we're inside a quoted string.
 * Structural whitespace (between keys/values) is left untouched.
 */
function sanitizeJsonStringValues(jsonStr) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];

    if (escaped) {
      // Previous char was a backslash inside a string — pass through as-is
      result += ch;
      escaped = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escaped = true;
        result += ch;
      } else if (ch === '"') {
        inString = false;
        result += ch;
      } else if (ch === "\n") {
        result += "\\n";
      } else if (ch === "\r") {
        result += "\\r";
      } else if (ch === "\t") {
        result += "\\t";
      } else if (ch.charCodeAt(0) < 0x20) {
        // Other control characters — strip them
        continue;
      } else {
        result += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
      }
      result += ch;
    }
  }

  return result;
}

function extractTestNames(content) {
  const names = [];
  const namePattern = /test\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let match;
  while ((match = namePattern.exec(content)) !== null) {
    names.push(match[1]);
  }
  return names;
}

// ─── Step 4: Push Tests to Branch ────────────────────────────────────────────

/**
 * Push generated test files to the internship/playwright-unit-tests branch.
 *
 * Flow:
 * 1. Get the branch tip ref (1 subrequest)
 * 2. Check which files already exist (N subrequests)
 * 3. Push with add/edit change types (1 subrequest)
 *
 * Returns { success: boolean, message: string }
 */
async function pushTests(project, repoId, generatedTests, prId, azureHeaders) {
  try {
    // 1. Get the branch tip ref
    const refsUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/refs?filter=heads/${PLAYWRIGHT_TEST_BRANCH}&api-version=${AZURE_API_VERSION}`;
    const refsRes = await fetch(refsUrl, { headers: azureHeaders });

    if (!refsRes.ok) {
      console.error(`(log) [Playwright] Failed to get branch ref: ${refsRes.status}`);
      return { success: false, message: `Failed to get branch ref: ${refsRes.status}` };
    }

    const refsData = await refsRes.json();
    const branchRef = (refsData.value || []).find(
      r => r.name === `refs/heads/${PLAYWRIGHT_TEST_BRANCH}`
    );

    if (!branchRef) {
      console.error("(log) [Playwright] Branch not found:", PLAYWRIGHT_TEST_BRANCH);
      return { success: false, message: `Branch ${PLAYWRIGHT_TEST_BRANCH} not found` };
    }

    const oldObjectId = branchRef.objectId;
    console.log(`(log) [Playwright] Branch tip: ${oldObjectId}`);

    // 2. Check which files already exist (in parallel)
    const existChecks = await Promise.allSettled(
      generatedTests.map(async (test) => {
        const checkUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent("/" + test.filePath)}&versionDescriptor.version=${encodeURIComponent(PLAYWRIGHT_TEST_BRANCH)}&versionDescriptor.versionType=branch&api-version=${AZURE_API_VERSION}`;
        const checkRes = await fetch(checkUrl, { headers: azureHeaders, method: "HEAD" });
        return { test, exists: checkRes.ok };
      })
    );

    const changes = existChecks
      .filter(r => r.status === "fulfilled")
      .map(r => {
        const { test, exists } = r.value;
        console.log(`(log) [Playwright] File ${test.filePath}: ${exists ? "edit" : "add"}`);
        return {
          changeType: exists ? "edit" : "add",
          item: { path: "/" + test.filePath },
          newContent: { content: test.content, contentType: "rawtext" },
        };
      });

    // 3. Push all files in a single commit
    const pushUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pushes?api-version=${AZURE_API_VERSION}`;
    const pushBody = {
      refUpdates: [
        {
          name: `refs/heads/${PLAYWRIGHT_TEST_BRANCH}`,
          oldObjectId,
        },
      ],
      commits: [
        {
          comment: `[AI] Playwright tests for PR #${prId}`,
          changes,
        },
      ],
    };

    const pushRes = await fetch(pushUrl, {
      method: "POST",
      headers: { ...azureHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(pushBody),
    });

    if (pushRes.ok) {
      console.log("(log) [Playwright] Push successful");
      return { success: true, message: "Tests pushed successfully" };
    } else {
      const errText = await pushRes.text();
      console.error(`(log) [Playwright] Push failed: ${pushRes.status}`, errText);
      return { success: false, message: `Push failed: ${pushRes.status}` };
    }
  } catch (e) {
    console.error("(log) [Playwright] Push error:", e.message);
    return { success: false, message: `Push error: ${e.message}` };
  }
}

// ─── Step 5: Trigger Pipeline ────────────────────────────────────────────────

/**
 * Trigger pipeline 88 to run the generated tests.
 * Returns true if triggered successfully.
 */
async function triggerPipeline(project, azureHeaders) {
  try {
    const pipelineUrl = `${ORG}/${project}/_apis/pipelines/${PIPELINE_ID}/runs?api-version=${AZURE_API_VERSION}`;
    const pipelineBody = {
      resources: {
        repositories: {
          self: {
            refName: `refs/heads/${PLAYWRIGHT_TEST_BRANCH}`,
          },
        },
      },
    };

    const res = await fetch(pipelineUrl, {
      method: "POST",
      headers: { ...azureHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(pipelineBody),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`(log) [Playwright] Pipeline ${PIPELINE_ID} triggered, run ID: ${data.id || "unknown"}`);
      return true;
    } else {
      console.error(`(log) [Playwright] Pipeline trigger failed: ${res.status}`, await res.text());
      return false;
    }
  } catch (e) {
    console.error("(log) [Playwright] Pipeline trigger error:", e.message);
    return false;
  }
}

// ─── Step 6: Post PR Comment ─────────────────────────────────────────────────

function buildComment(generatedTests, componentFiles, docsCount, errorMsg, pushSuccess, pipelineTriggered) {
  const body = [`## 🎭 Playwright Test Generation`, ``];

  if (errorMsg) {
    body.push(`⚠️ ${errorMsg}`, ``);
  } else {
    body.push(`Generated **${generatedTests.length}** test file(s) using **${docsCount}** documentation file(s) as context.`, ``);

    if (pushSuccess) {
      body.push(`✅ Tests pushed to \`${PLAYWRIGHT_TEST_BRANCH}\``);
      if (pipelineTriggered) {
        body.push(`✅ Pipeline #${PIPELINE_ID} triggered`);
      } else {
        body.push(`⚠️ Pipeline trigger failed — run manually if needed`);
      }
    } else {
      body.push(`❌ Could not push tests to branch — see worker logs for details`);
    }
    body.push(``);

    // List generated test files
    if (generatedTests.length > 0) {
      body.push(`### Generated Test Files`);
      for (const t of generatedTests) {
        body.push(`- \`${t.filePath}\``);
      }
      body.push(``);
    }
  }

  // List changed components
  if (componentFiles.length > 0) {
    body.push(`### Changed Components Analyzed`);
    for (const f of componentFiles) {
      body.push(`- \`${f.path}\``);
    }
    body.push(``);
  }

  body.push(`---`, `_Generated by AI PR Review Bot — Playwright Test Gen_`);
  return body.join("\n");
}

async function postComment(project, repoId, prId, azureHeaders, content) {
  const threadUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=${AZURE_API_VERSION}`;
  const payload = {
    comments: [
      {
        parentCommentId: 0,
        content,
        commentType: 1,
      },
    ],
    status: 4,
  };

  try {
    const res = await fetch(threadUrl, {
      method: "POST",
      headers: { ...azureHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      console.log("(log) [Playwright] Comment posted to PR");
    } else {
      console.error("(log) [Playwright] Comment post failed:", res.status, await res.text());
    }
  } catch (e) {
    console.error("(log) [Playwright] Comment post error:", e.message);
  }
}

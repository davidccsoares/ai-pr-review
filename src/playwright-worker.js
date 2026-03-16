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
const MAX_DIFF_SIZE = 50000;

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

      // Build simplified file changes (fetch new file content for diffs)
      const fileChanges = [];
      for (const e of entries) {
        if (!e.item?.path || e.item.path.endsWith("/")) continue;
        const ct = typeof e.changeType === "string" ? e.changeType.toLowerCase() : e.changeType;
        const isEdit = ct === "edit" || ct === 2;
        const isAdd = ct === "add" || ct === 1;
        if (!isEdit && !isAdd) continue;

        // Fetch the new file content
        const fileUrl = `${ORG}/${PLAYWRIGHT_PROJECT}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(e.item.path)}&versionDescriptor.version=${sourceCommit}&versionDescriptor.versionType=commit&includeContent=true&api-version=${AZURE_API_VERSION}`;
        const fileRes = await fetch(fileUrl, { headers: azureHeaders });
        if (!fileRes.ok) continue;
        const content = await fileRes.text();

        const lines = content.split("\n").slice(0, 80);
        const diff = lines.map((l, idx) => `+${idx + 1}: ${l}`).join("\n");

        fileChanges.push({ path: e.item.path, diff, isAdd });

        if (fileChanges.length >= 15) break; // Limit to conserve subrequests
      }

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

    // 2. Fetch .md documentation from the test branch
    const mdDocs = await fetchMdDocs(project, repoId, azureHeaders);
    console.log(`(log) [Playwright] Fetched ${mdDocs.length} .md documentation files`);

    // 2b. Fetch existing test infrastructure from the test branch (actionsFixture + existing Actions/spec files)
    const existingFiles = await fetchExistingTestFiles(project, repoId, componentFiles, azureHeaders);
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
      for (const t of generatedTests) {
        console.log(`(log) [Playwright] [DRY RUN] Would create: ${t.filePath} (${t.content.length} chars)`);
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
 * Fetch the specific documentation files (REPOSITORY_CONTEXT.md, PULSE_REFERENCE.md)
 * from the internship/playwright-unit-tests branch.
 *
 * Subrequests: 1 per file = 2 total
 */
async function fetchMdDocs(project, repoId, azureHeaders) {
  const mdDocs = [];

  console.log(`(log) [Playwright] Fetching ${MD_DOC_PATHS.length} doc files from branch: ${PLAYWRIGHT_TEST_BRANCH}`);

  for (const docPath of MD_DOC_PATHS) {
    try {
      const contentUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(docPath)}&versionDescriptor.version=${encodeURIComponent(PLAYWRIGHT_TEST_BRANCH)}&versionDescriptor.versionType=branch&includeContent=true&api-version=${AZURE_API_VERSION}`;
      const contentRes = await fetch(contentUrl, { headers: azureHeaders });

      if (contentRes.ok) {
        let content = await contentRes.text();
        if (content.length > MAX_MD_CHARS) {
          content = content.substring(0, MAX_MD_CHARS) + "\n...(truncated)";
        }
        mdDocs.push({ path: docPath, content });
        console.log(`(log) [Playwright] Fetched: ${docPath} (${content.length} chars)`);
      } else {
        console.log(`(log) [Playwright] Could not fetch ${docPath}: ${contentRes.status}`);
      }
    } catch (e) {
      console.error(`(log) [Playwright] Error fetching ${docPath}:`, e.message);
    }
  }

  return mdDocs;
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
  const existing = [];

  // Paths to check: always fetch actionsFixture.ts
  const pathsToCheck = ["/tests/fixtures/actionsFixture.ts"];

  // For each component stem, check if Actions and spec files already exist
  const stems = [...new Set(componentFiles.map(f => f.stem))];
  for (const stem of stems) {
    // Try common locations based on repo structure
    pathsToCheck.push(`/tests/components/${stem}/${stem}Actions.ts`);
    pathsToCheck.push(`/tests/components/${stem}/${stem}.spec.ts`);
  }

  for (const filePath of pathsToCheck) {
    try {
      const contentUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(filePath)}&versionDescriptor.version=${encodeURIComponent(PLAYWRIGHT_TEST_BRANCH)}&versionDescriptor.versionType=branch&includeContent=true&api-version=${AZURE_API_VERSION}`;
      const contentRes = await fetch(contentUrl, { headers: azureHeaders });

      if (contentRes.ok) {
        let content = await contentRes.text();
        // Truncate large files to conserve prompt space — we only need the structure
        if (content.length > 4000) {
          content = content.substring(0, 4000) + "\n...(truncated)";
        }
        existing.push({ path: filePath, content });
        console.log(`(log) [Playwright] Existing file found: ${filePath} (${content.length} chars)`);
      }
    } catch (e) {
      // Silently skip — file doesn't exist, which is fine
    }
  }

  return existing;
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

  // Build existing test files context
  let existingContext = "";
  if (existingFiles.length > 0) {
    existingContext = "\n## Existing Test Files (already on the test branch)\n\n";
    existingContext += "These files ALREADY EXIST. Do NOT regenerate them. Reuse their classes and imports.\n\n";
    for (const ef of existingFiles) {
      existingContext += `### ${ef.path}\n\`\`\`typescript\n${ef.content}\n\`\`\`\n\n`;
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
Respond with ONLY a raw JSON array, no markdown, no code fences:
[{"filePath": "tests/components/feature/feature.spec.ts", "content": "import { test, expect } from '../../fixtures/actionsFixture';\\n..."}]
If you also generate an Actions file, include it as a separate entry:
[{"filePath": "tests/components/feature/featureActions.ts", "content": "..."}, {"filePath": "tests/components/feature/feature.spec.ts", "content": "..."}]

─── RULES ───────────────────────────────────────────────────────────────────
1. Generate one spec file per logical component/feature changed.
2. Check the "Existing Test Files" section FIRST:
   - If the Actions class is already in actionsFixture.ts, use \`actions.<name>\` — do NOT regenerate the Actions file.
   - If the Actions file exists but is NOT in the fixture, import it directly and instantiate with \`new\`.
   - If the spec file already exists, only generate NEW tests that cover the PR diff — do NOT duplicate existing tests.
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

    // Parse the JSON array
    let tests;
    if (Array.isArray(raw)) {
      tests = raw;
    } else if (typeof raw === "string") {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      tests = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
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
      const actionMatches = fixtureFile.content.matchAll(/(\w+):\s*new\s+\w+Actions\(page\)/g);
      for (const m of actionMatches) {
        registeredActions.add(m[1].toLowerCase());
      }
      console.log(`(log) [Playwright] Registered fixture actions: ${[...registeredActions].join(", ")}`);
    }

    // Validate each test has required fields and post-process common AI mistakes
    return tests.filter(t => t.filePath && t.content).map(t => {
      let filePath = t.filePath.replace(/^\//, ""); // strip leading slash

      // Ensure spec files live under tests/components/ (fix flat paths like "tests/dashboard.spec.ts")
      if (filePath.match(/^tests\/[^/]+\.spec\.ts$/) && !filePath.startsWith("tests/components/")) {
        const name = filePath.replace("tests/", "").replace(".spec.ts", "");
        filePath = `tests/components/${name}/${name}.spec.ts`;
      }

      // Fix wrong import: replace '@playwright/test' test import with actionsFixture
      let content = t.content;
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
        // Detect patterns like: new DashboardActions(page) or let dashboardActions = new DashboardActions(page)
        const manualInstMatch = content.match(/new\s+(\w+)Actions\(page\)/);
        if (manualInstMatch) {
          const className = manualInstMatch[1]; // e.g., "Dashboard"
          const fixtureKey = className.charAt(0).toLowerCase() + className.slice(1); // e.g., "dashboard"
          if (registeredActions.has(fixtureKey.toLowerCase())) {
            console.log(`(log) [Playwright] Post-fix: ${className}Actions is in fixture as actions.${fixtureKey} — rewriting spec to use fixture`);

            // Remove the manual import of the Actions class
            content = content.replace(
              new RegExp(`import\\s*\\{\\s*${className}Actions\\s*\\}\\s*from\\s*['"][^'"]+['"];?\\n?`, "g"),
              ""
            );

            // Remove manual instantiation lines (let/const varName = new XActions(page))
            const varName = fixtureKey + "Actions";
            content = content.replace(
              new RegExp(`\\s*(let|const)\\s+${varName}\\s*[:=][^;]*;?\\n?`, "gi"),
              "\n"
            );
            content = content.replace(
              new RegExp(`\\s*${varName}\\s*=\\s*new\\s+${className}Actions\\(page\\);?\\n?`, "gi"),
              "\n"
            );

            // Replace usages: dashboardActions.method() -> actions.dashboard.method()
            // Also handle: await dashboardActions. -> await actions.dashboard.
            content = content.replace(
              new RegExp(`${varName}\\.`, "g"),
              `actions.${fixtureKey}.`
            );

            // Ensure test callbacks destructure { actions } if they only had { page } or {}
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

    // 2. Check which files already exist
    const changes = [];
    for (const test of generatedTests) {
      const checkUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent("/" + test.filePath)}&versionDescriptor.version=${encodeURIComponent(PLAYWRIGHT_TEST_BRANCH)}&versionDescriptor.versionType=branch&api-version=${AZURE_API_VERSION}`;
      const checkRes = await fetch(checkUrl, { headers: azureHeaders, method: "HEAD" });
      const exists = checkRes.ok;

      changes.push({
        changeType: exists ? "edit" : "add",
        item: { path: "/" + test.filePath },
        newContent: {
          content: test.content,
          contentType: "rawtext",
        },
      });
      console.log(`(log) [Playwright] File ${test.filePath}: ${exists ? "edit" : "add"}`);
    }

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

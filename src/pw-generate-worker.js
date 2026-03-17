/**
 * Playwright Generate Worker ("The Brain")
 *
 * Receives pre-built context (docs, existing files, component diffs) from
 * the context worker and:
 *   1. Builds the AI prompt from the context
 *   2. Calls Workers AI (Mistral Small 3.1 24B)
 *   3. Parses/sanitizes the JSON response
 *   4. Post-processes: import fixes, fixture rewrites, test merging
 *   5. Returns the generated tests array
 *
 * Subrequest budget: ~2 (AI call + optional pw-push call in future)
 * This worker will NEVER hit the 50-subrequest limit.
 */

const CF_AI_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";

// ─── Neuron Tracking ────────────────────────────────────────────────────────
const NEURON_DAILY_LIMIT = 9000;
const NEURONS_PER_INPUT_CHAR = 31876 / 4_000_000;
const NEURONS_PER_OUTPUT_CHAR = 50488 / 4_000_000;

async function checkNeuronBudget(env) {
  if (!env?.BOT_KV) return { allowed: true, used: 0 };
  try {
    const today = new Date().toISOString().slice(0, 10);
    const used = parseInt(await env.BOT_KV.get(`neurons:${today}`) || "0", 10);
    return { allowed: used < NEURON_DAILY_LIMIT, used };
  } catch (e) {
    console.log("(log) [PW-Generate] KV read error (neuron check):", e.message);
    return { allowed: true, used: 0 };
  }
}

async function recordNeuronUsage(env, inputChars, outputChars) {
  if (!env?.BOT_KV) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const key = `neurons:${today}`;
    const current = parseInt(await env.BOT_KV.get(key) || "0", 10);
    const estimated = Math.ceil(
      inputChars * NEURONS_PER_INPUT_CHAR +
      outputChars * NEURONS_PER_OUTPUT_CHAR
    );
    const newTotal = current + estimated;
    await env.BOT_KV.put(key, String(newTotal), { expirationTtl: 86400 });
    console.log(`(log) [PW-Generate] Neurons: +${estimated} (total today: ${newTotal})`);
  } catch (e) {
    console.log("(log) [PW-Generate] KV write error (neuron record):", e.message);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ─── GET / — health check ───
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("pw-generate worker is running", { status: 200 });
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

    const { componentFiles, mdDocs, existingFiles, prTitle } = payload;
    if (!componentFiles || !prTitle) {
      return new Response(
        "Missing required fields: componentFiles, prTitle",
        { status: 400 }
      );
    }

    console.log(`(log) [PW-Generate] Received ${componentFiles.length} component file(s) for: "${prTitle}"`);

    try {
      const generatedTests = await generateTests(
        componentFiles,
        mdDocs || [],
        existingFiles || [],
        prTitle,
        env
      );

      return new Response(
        JSON.stringify({ success: true, tests: generatedTests || [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (e) {
      console.error("(log) [PW-Generate] Error:", e.stack || e.message);
      return new Response(
        JSON.stringify({ success: false, error: e.message, tests: [] }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};

// ─── AI Test Generation ──────────────────────────────────────────────────────

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
    console.log("(log) [PW-Generate] Generating tests for", componentFiles.length, "files with", mdDocs.length, "docs");

    // Check neuron budget before calling AI
    const budget = await checkNeuronBudget(env);
    if (!budget.allowed) {
      console.log(`(log) [PW-Generate] Neuron budget exhausted (${budget.used}/${NEURON_DAILY_LIMIT}), skipping test generation`);
      return null;
    }

    const aiResponse = await env.AI.run(CF_AI_MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4096,
    });

    const raw = aiResponse?.response;
    const rawStr = typeof raw === "string" ? raw.trim() : JSON.stringify(raw);
    console.log("(log) [PW-Generate] AI response length:", rawStr?.length ?? 0);

    // Record neuron usage
    const inputChars = systemPrompt.length + userPrompt.length;
    const outputChars = rawStr?.length || 0;
    await recordNeuronUsage(env, inputChars, outputChars);

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
          try {
            const sanitized = sanitizeJsonStringValues(jsonStr);
            tests = JSON.parse(sanitized);
          } catch (e2) {
            console.error("(log) [PW-Generate] JSON parse failed after sanitization:", e2.message);
            console.log("(log) [PW-Generate] Raw AI response (first 500 chars):", rawStr?.substring(0, 500));
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
      console.log("(log) [PW-Generate] AI did not return valid test array");
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
      console.log(`(log) [PW-Generate] Registered fixture actions: ${[...registeredActions].join(", ")}`);
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
          console.log(`(log) [PW-Generate] Appending new tests into existing ${filePath}`);
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
          console.log(`(log) [PW-Generate] AI returned full file for existing spec — extracting new tests only`);
          const newTestBlocks = extractTestBlocks(content);
          const existingTestNames = extractTestNames(existingFull);
          // Filter to only genuinely new tests
          const uniqueNewTests = newTestBlocks.filter(
            block => !existingTestNames.some(name => block.includes(name))
          );
          if (uniqueNewTests.length === 0) {
            console.log(`(log) [PW-Generate] No new tests to add to ${filePath} — all already exist`);
            content = null; // Mark for removal
          } else {
            console.log(`(log) [PW-Generate] Merging ${uniqueNewTests.length} new test(s) into existing ${filePath}`);
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
            console.log(`(log) [PW-Generate] Post-fix: ${className}Actions is in fixture as actions.${fixtureKey} — rewriting spec to use fixture`);
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
        console.log(`(log) [PW-Generate] Skipping ${t.filePath} — already exists on test branch`);
        return false;
      }
      return true;
    });
  } catch (e) {
    console.error("(log) [PW-Generate] AI test generation failed:", e.message);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
        // Include the closing ");"
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
function extractTestNames(content) {
  const names = [];
  const namePattern = /test\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let match;
  while ((match = namePattern.exec(content)) !== null) {
    names.push(match[1]);
  }
  return names;
}

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

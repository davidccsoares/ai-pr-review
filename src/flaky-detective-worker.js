/**
 * Flaky Test Detective Worker
 *
 * Tracks Playwright test flakiness over a 14-day rolling window.
 * Triggered by a POST /ingest from the Azure DevOps pipeline after
 * each test run completes. Exposes a GET /report dashboard.
 *
 * Routes:
 *   GET  /        — Health check
 *   POST /ingest  — Receive buildId, fetch test results, detect flakiness
 *   GET  /report  — HTML dashboard (default) or JSON (?format=json)
 */

import { azureHeaders, orgUrl, AZURE_API_VERSION } from "./lib/azure.js";
import { fetchWithTimeout } from "./lib/fetch.js";
import { fetchWithRetry } from "./lib/fetch.js";

/** 14 days in seconds */
const TTL_14_DAYS = 1_209_600;
/** Max runs to keep in the index */
const MAX_RUNS_INDEX = 100;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ─── GET / — health check ───────────────────────────────────
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        status: "ok",
        worker: "flaky-detective",
      });
    }

    // ─── POST /ingest — receive build results ───────────────────
    if (request.method === "POST" && url.pathname === "/ingest") {
      return handleIngest(request, env, ctx);
    }

    // ─── GET /report — dashboard ────────────────────────────────
    if (request.method === "GET" && url.pathname === "/report") {
      return handleReport(url, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// POST /ingest
// ═════════════════════════════════════════════════════════════════════════════

async function handleIngest(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { buildId } = body;
  if (!buildId) {
    return new Response("Missing buildId", { status: 400 });
  }

  console.log(`(log) [FlakyDetective] Ingesting build ${buildId}`);

  // Run the heavy lifting in the background so we respond quickly
  ctx.waitUntil(ingestBuild(String(buildId), env));

  return Response.json({ accepted: true, buildId });
}

/**
 * Fetch test runs and results from Azure DevOps, detect flaky tests,
 * and persist everything to KV.
 */
async function ingestBuild(buildId, env) {
  const headers = {
    ...azureHeaders(env.AZURE_TOKEN),
    "Content-Type": "application/json",
  };
  const ORG = orgUrl(env);
  const project = env.AZURE_PROJECT || "BindTuning";

  try {
    // 1. List test runs for this build
    const runsUrl =
      `${ORG}/${project}/_apis/test/runs` +
      `?buildUri=vstfs:///Build/Build/${buildId}` +
      `&api-version=${AZURE_API_VERSION}`;

    const runsRes = await fetchWithRetry(runsUrl, { headers, timeout: 15_000, retries: 3, tag: "FlakyDetective" });
    if (!runsRes.ok) {
      console.error(`(log) [FlakyDetective] Failed to fetch test runs: ${runsRes.status}`);
      return;
    }

    const runsData = await runsRes.json();
    const testRuns = runsData.value || [];

    if (testRuns.length === 0) {
      console.log(`(log) [FlakyDetective] No test runs found for build ${buildId}`);
      return;
    }

    console.log(`(log) [FlakyDetective] Found ${testRuns.length} test run(s) for build ${buildId}`);

    // 2. Fetch all test results across all runs (in parallel)
    const resultsBatches = await Promise.allSettled(
      testRuns.map(run => fetchTestResults(ORG, project, run.id, headers))
    );
    const allResults = [];
    for (const batch of resultsBatches) {
      if (batch.status === "fulfilled") {
        allResults.push(...batch.value);
      }
    }

    console.log(`(log) [FlakyDetective] Fetched ${allResults.length} total test result(s)`);

    // 3. Identify flaky tests
    const { flakyTests, stats } = detectFlakiness(allResults);

    console.log(
      `(log) [FlakyDetective] Build ${buildId}: ` +
      `${stats.total} total, ${stats.passed} passed, ${stats.failed} failed, ` +
      `${flakyTests.length} flaky`
    );

    // 4. Store flaky test data in KV
    const now = new Date().toISOString();

    for (const flaky of flakyTests) {
      await upsertFlakyTest(env, flaky, buildId, now);
    }

    // 5. Store run summary
    const runSummary = {
      date: now,
      totalTests: stats.total,
      passed: stats.passed,
      failed: stats.failed,
      flaky: flakyTests.length,
      flakyTests: flakyTests.map((f) => f.testName),
      duration: stats.duration,
    };

    await env.BOT_KV.put(`flaky-run:${buildId}`, JSON.stringify(runSummary), {
      expirationTtl: TTL_14_DAYS,
    });

    // 6. Update the runs index
    await updateRunsIndex(env, buildId, now);

    console.log(`(log) [FlakyDetective] Build ${buildId} ingestion complete`);
  } catch (err) {
    console.error(`(log) [FlakyDetective] Ingestion error:`, err.stack || err.message);
  }
}

/**
 * Fetch all test results for a single test run (handles pagination).
 */
async function fetchTestResults(orgUrl, project, runId, headers) {
  const results = [];
  let skip = 0;
  const top = 1000;

  while (true) {
    const url =
      `${orgUrl}/${project}/_apis/test/runs/${runId}/results` +
      `?api-version=${AZURE_API_VERSION}&$top=${top}&$skip=${skip}`;

    const res = await fetchWithRetry(url, { headers, timeout: 15_000, retries: 3, tag: "FlakyDetective" });
    if (!res.ok) {
      console.error(`(log) [FlakyDetective] Failed to fetch results for run ${runId}: ${res.status}`);
      break;
    }

    const data = await res.json();
    const batch = data.value || [];
    results.push(...batch);

    // If we got fewer than $top, there are no more pages
    if (batch.length < top) break;
    skip += top;
  }

  return results;
}

/**
 * Detect flaky tests from Azure DevOps test results.
 *
 * How Playwright retries work in Azure DevOps:
 * When retries are configured (e.g., retries: 2), the JUnit reporter creates
 * separate <testcase> entries for each attempt. Azure DevOps surfaces each as
 * a separate result with the same `automatedTestName`.
 *
 * A test is **flaky** if it has at least one Failed result AND a Passed result
 * for the same automatedTestName within the same build.
 *
 * @returns {{ flakyTests: Array<{testName, errorMessage}>, stats: object }}
 */
function detectFlakiness(results) {
  // Group results by automatedTestName
  const byTestName = new Map();

  for (const r of results) {
    const name = r.automatedTestName || r.testCaseTitle || "Unknown";
    if (!byTestName.has(name)) {
      byTestName.set(name, []);
    }
    byTestName.get(name).push(r);
  }

  const flakyTests = [];
  let totalUniqueTests = 0;
  let passedUnique = 0;
  let failedUnique = 0;
  let totalDuration = 0;

  for (const [testName, attempts] of byTestName) {
    totalUniqueTests++;

    const hasPass = attempts.some((a) => a.outcome === "Passed");
    const hasFail = attempts.some((a) => a.outcome === "Failed");

    // Sum duration across all attempts
    for (const a of attempts) {
      totalDuration += a.durationInMs || 0;
    }

    if (hasPass && hasFail) {
      // Flaky: failed at least once, but ultimately passed
      const failedAttempt = attempts.find((a) => a.outcome === "Failed");
      flakyTests.push({
        testName,
        errorMessage: failedAttempt?.errorMessage || "",
        stackTrace: failedAttempt?.stackTrace || "",
      });
      passedUnique++; // Counts as passed since it ultimately succeeded
    } else if (hasPass) {
      passedUnique++;
    } else if (hasFail) {
      failedUnique++;
    }
    // NotExecuted / Inconclusive are counted in total but not pass/fail
  }

  return {
    flakyTests,
    stats: {
      total: totalUniqueTests,
      passed: passedUnique,
      failed: failedUnique,
      duration: totalDuration,
    },
  };
}

/**
 * Upsert a flaky test entry in KV.
 * Adds the new occurrence and refreshes the TTL.
 */
async function upsertFlakyTest(env, flaky, buildId, date) {
  const key = `flaky:${flaky.testName}`;
  let existing;

  try {
    const raw = await env.BOT_KV.get(key);
    existing = raw ? JSON.parse(raw) : null;
  } catch {
    existing = null;
  }

  if (existing) {
    // Check if this buildId was already recorded (idempotency)
    const alreadyRecorded = existing.occurrences.some((o) => o.buildId === buildId);
    if (!alreadyRecorded) {
      existing.occurrences.push({
        date,
        buildId,
        errorMessage: truncate(flaky.errorMessage, 500),
      });
      existing.lastSeen = date;
      existing.totalFlakes = existing.occurrences.length;
    }
  } else {
    existing = {
      occurrences: [
        {
          date,
          buildId,
          errorMessage: truncate(flaky.errorMessage, 500),
        },
      ],
      firstSeen: date,
      lastSeen: date,
      totalFlakes: 1,
    };
  }

  await env.BOT_KV.put(key, JSON.stringify(existing), {
    expirationTtl: TTL_14_DAYS,
  });
}

/**
 * Update the runs index with the latest build.
 * Keeps the list capped at MAX_RUNS_INDEX entries.
 */
async function updateRunsIndex(env, buildId, date) {
  const key = "flaky-runs-index";
  let index = [];

  try {
    const raw = await env.BOT_KV.get(key);
    index = raw ? JSON.parse(raw) : [];
  } catch {
    index = [];
  }

  // Prevent duplicates
  if (!index.some((entry) => entry.buildId === buildId)) {
    index.unshift({ buildId, date });
  }

  // Cap at MAX_RUNS_INDEX
  if (index.length > MAX_RUNS_INDEX) {
    index = index.slice(0, MAX_RUNS_INDEX);
  }

  await env.BOT_KV.put(key, JSON.stringify(index), {
    expirationTtl: TTL_14_DAYS,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /report
// ═════════════════════════════════════════════════════════════════════════════

async function handleReport(url, env) {
  const format = url.searchParams.get("format");

  // 1. Read the runs index
  let runsIndex = [];
  try {
    const raw = await env.BOT_KV.get("flaky-runs-index");
    runsIndex = raw ? JSON.parse(raw) : [];
  } catch {
    runsIndex = [];
  }

  // 2. Fetch all run summaries (parallel)
  const runSummaries = await Promise.all(
    runsIndex.map(async (entry) => {
      try {
        const raw = await env.BOT_KV.get(`flaky-run:${entry.buildId}`);
        return raw ? { buildId: entry.buildId, ...JSON.parse(raw) } : null;
      } catch {
        return null;
      }
    })
  );
  const validRuns = runSummaries.filter(Boolean);

  // 3. List all flaky: entries from KV
  const flakyEntries = [];
  let cursor = undefined;
  while (true) {
    const listResult = await env.BOT_KV.list({
      prefix: "flaky:",
      cursor,
      limit: 1000,
    });

    for (const key of listResult.keys) {
      // Skip non-test keys (e.g., flaky-run:, flaky-runs-index)
      // The prefix "flaky:" also matches "flaky-run:" and "flaky-runs-index"
      // so we need to filter: real flaky test keys start with "flaky:" but NOT "flaky-run" or "flaky-runs"
      if (key.name.startsWith("flaky-run") || key.name === "flaky-runs-index") {
        continue;
      }
      try {
        const raw = await env.BOT_KV.get(key.name);
        if (raw) {
          const data = JSON.parse(raw);
          flakyEntries.push({
            testName: key.name.replace(/^flaky:/, ""),
            ...data,
          });
        }
      } catch {
        // skip corrupted entries
      }
    }

    if (listResult.list_complete) break;
    cursor = listResult.cursor;
  }

  // Sort by flake count descending
  flakyEntries.sort((a, b) => b.totalFlakes - a.totalFlakes);

  const reportData = {
    generatedAt: new Date().toISOString(),
    totalRuns: validRuns.length,
    totalUniqueFlaky: flakyEntries.length,
    mostFlaky: flakyEntries[0]
      ? { testName: flakyEntries[0].testName, count: flakyEntries[0].totalFlakes }
      : null,
    flakyTests: flakyEntries,
    recentRuns: validRuns,
  };

  // ── JSON format ──────────────────────────────────────────────
  if (format === "json") {
    return Response.json(reportData, {
      headers: { "Cache-Control": "no-cache" },
    });
  }

  // ── HTML format ──────────────────────────────────────────────
  return new Response(buildHtml(reportData), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// HTML Report Builder
// ═════════════════════════════════════════════════════════════════════════════

function buildHtml(data) {
  const { generatedAt, totalRuns, totalUniqueFlaky, mostFlaky, flakyTests, recentRuns } = data;

  const flakyRows = flakyTests
    .map(
      (f) => `
      <tr>
        <td class="test-name" title="${esc(f.testName)}">${esc(shortenTestName(f.testName))}</td>
        <td class="center">${f.totalFlakes}</td>
        <td class="error" title="${esc(f.occurrences?.[f.occurrences.length - 1]?.errorMessage || "")}">${esc(
        truncate(f.occurrences?.[f.occurrences.length - 1]?.errorMessage || "—", 120)
      )}</td>
        <td class="center">${formatDate(f.firstSeen)}</td>
        <td class="center">${formatDate(f.lastSeen)}</td>
      </tr>`
    )
    .join("");

  const runRows = recentRuns
    .map(
      (r) => `
      <tr>
        <td class="center">${esc(r.buildId)}</td>
        <td class="center">${formatDate(r.date)}</td>
        <td class="center">${r.totalTests}</td>
        <td class="center passed">${r.passed}</td>
        <td class="center failed">${r.failed}</td>
        <td class="center flaky">${r.flaky}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flaky Test Detective</title>
<style>
  :root {
    --bg: #f8f9fa;
    --surface: #ffffff;
    --text: #1a1a2e;
    --text-secondary: #6c757d;
    --border: #dee2e6;
    --accent: #4361ee;
    --passed-bg: #d4edda;
    --passed-text: #155724;
    --failed-bg: #f8d7da;
    --failed-text: #721c24;
    --flaky-bg: #fff3cd;
    --flaky-text: #856404;
    --card-shadow: 0 2px 8px rgba(0,0,0,0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --text: #e6edf3;
      --text-secondary: #8b949e;
      --border: #30363d;
      --accent: #58a6ff;
      --passed-bg: #0d2818;
      --passed-text: #3fb950;
      --failed-bg: #2d1014;
      --failed-text: #f85149;
      --flaky-bg: #2d2200;
      --flaky-text: #e3b341;
      --card-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 2rem;
    max-width: 1200px;
    margin: 0 auto;
  }
  h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
  .subtitle { color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 2rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem;
    box-shadow: var(--card-shadow);
  }
  .card .label { font-size: 0.8rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.8rem; font-weight: 700; margin-top: 0.25rem; }
  .card .detail { font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.25rem; word-break: break-all; }
  h2 { font-size: 1.3rem; margin: 2rem 0 1rem; }
  .table-wrap { overflow-x: auto; margin-bottom: 2rem; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 8px; overflow: hidden; box-shadow: var(--card-shadow); }
  th { background: var(--border); padding: 0.75rem 1rem; text-align: left; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); }
  td { padding: 0.6rem 1rem; border-top: 1px solid var(--border); font-size: 0.875rem; }
  .center { text-align: center; }
  .test-name { max-width: 400px; word-break: break-all; font-family: 'SF Mono', Consolas, monospace; font-size: 0.8rem; }
  .error { max-width: 300px; font-size: 0.8rem; color: var(--failed-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .passed { color: var(--passed-text); font-weight: 600; }
  .failed { color: var(--failed-text); font-weight: 600; }
  .flaky { color: var(--flaky-text); font-weight: 600; }
  .empty { text-align: center; padding: 3rem; color: var(--text-secondary); }
  footer { text-align: center; color: var(--text-secondary); font-size: 0.8rem; margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); }
  tr:hover { background: color-mix(in srgb, var(--accent) 5%, transparent); }
  @media (max-width: 768px) {
    body { padding: 1rem; }
    .cards { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <h1>&#128269; Flaky Test Detective</h1>
  <p class="subtitle">Last updated: ${formatDate(generatedAt)} &bull; <a href="/report?format=json" style="color:var(--accent)">JSON</a></p>

  <div class="cards">
    <div class="card">
      <div class="label">Runs Analyzed (14d)</div>
      <div class="value">${totalRuns}</div>
    </div>
    <div class="card">
      <div class="label">Unique Flaky Tests</div>
      <div class="value flaky">${totalUniqueFlaky}</div>
    </div>
    <div class="card">
      <div class="label">Most Flaky Test</div>
      <div class="value flaky">${mostFlaky ? mostFlaky.count + "x" : "—"}</div>
      <div class="detail">${mostFlaky ? esc(shortenTestName(mostFlaky.testName)) : "No flaky tests detected"}</div>
    </div>
  </div>

  <h2>Flaky Tests</h2>
  <div class="table-wrap">
  ${
    flakyTests.length === 0
      ? '<div class="empty">No flaky tests detected in the last 14 days. &#127881;</div>'
      : `<table>
      <thead>
        <tr>
          <th>Test Name</th>
          <th>Flake Count</th>
          <th>Last Error</th>
          <th>First Seen</th>
          <th>Last Seen</th>
        </tr>
      </thead>
      <tbody>${flakyRows}</tbody>
    </table>`
  }
  </div>

  <h2>Recent Pipeline Runs</h2>
  <div class="table-wrap">
  ${
    recentRuns.length === 0
      ? '<div class="empty">No runs ingested yet. Trigger a pipeline run to get started.</div>'
      : `<table>
      <thead>
        <tr>
          <th>Build ID</th>
          <th>Date</th>
          <th>Total</th>
          <th>Passed</th>
          <th>Failed</th>
          <th>Flaky</th>
        </tr>
      </thead>
      <tbody>${runRows}</tbody>
    </table>`
  }
  </div>

  <footer>Data retained for 14 days &bull; Powered by Cloudflare Workers</footer>
</body>
</html>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Utilities
// ═════════════════════════════════════════════════════════════════════════════

/** Truncate a string to a max length, appending "…" if truncated. */
function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/** Escape HTML entities for safe rendering. */
function esc(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Shorten a fully-qualified test name for display.
 * E.g. "BindTuning.AdminApp.Tests.Homepage.spec.ts > Homepage > should load"
 * → "Homepage.spec.ts > Homepage > should load"
 */
function shortenTestName(name) {
  if (!name) return "";
  // If the name contains " > ", take from the last ".spec" or ".test" segment
  const specMatch = name.match(/([^.> ]*\.(?:spec|test)\.[^>]+>.*)/);
  if (specMatch) return specMatch[1].trim();
  // Otherwise, if longer than 80 chars, take the last 80
  if (name.length > 80) return "…" + name.slice(-79);
  return name;
}

/** Format an ISO date string for display. */
function formatDate(isoStr) {
  if (!isoStr) return "—";
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoStr;
  }
}

// ─── Exports for testing ────────────────────────────────────────────────────
export { detectFlakiness, upsertFlakyTest, updateRunsIndex, truncate, esc, shortenTestName, formatDate };

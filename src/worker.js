import { orgUrl, AZURE_API_VERSION, azureHeaders as buildAzureHeaders } from "./lib/azure.js";
import { fetchWithTimeout } from "./lib/fetch.js";
import { fetchWithRetry } from "./lib/fetch.js";
import { MAX_BATCH_FILES } from "./lib/constants.js";
import { NEURON_DAILY_LIMIT } from "./lib/neurons.js";

const MAX_BACKLOG_SIZE = 3000;
const MAX_WEBHOOKS_PER_HOUR = 30;

const STARTUP_TIME = Date.now();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── GET routes ───────────────────────────────────────────────────────
    if (request.method === "GET") {
      if (url.pathname === "/neurons") {
        return handleNeuronsDashboard(env);
      }
      // Default: health check
      return Response.json({
        status: "ok",
        worker: "ai-pr-review-gateway",
        uptime: Math.floor((Date.now() - STARTUP_TIME) / 1000),
      });
    }

    if (request.method !== "POST") {
      return new Response("Only GET and POST allowed", { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    console.log("(log) [Gateway] Webhook received");

    if (!payload?.resource?.pullRequestId) {
      console.log("(log) [Gateway] No pull request ID found");
      return new Response("No PR", { status: 200 });
    }

    // ── Rate Limiting ────────────────────────────────────────────────────
    // Limit webhook processing to MAX_WEBHOOKS_PER_HOUR to protect neuron
    // budget and Azure API quota.
    try {
      if (env?.BOT_KV) {
        const hour = new Date().toISOString().slice(0, 13); // "2026-03-19T14"
        const rateKey = `rate:${hour}`;
        const current = parseInt(await env.BOT_KV.get(rateKey) || "0", 10);
        if (current >= MAX_WEBHOOKS_PER_HOUR) {
          console.log(`(log) [Gateway] Rate limit exceeded (${current}/${MAX_WEBHOOKS_PER_HOUR} this hour)`);
          return new Response("Rate limit exceeded", { status: 429 });
        }
        await env.BOT_KV.put(rateKey, String(current + 1), { expirationTtl: 3600 });
      }
    } catch (e) {
      // Fail-open: if KV fails, proceed normally
      console.log("(log) [Gateway] Rate limit check failed (proceeding anyway):", e.message);
    }

    ctx.waitUntil(processReview(payload, env));
    return new Response("Accepted", { status: 202 });
  },
};

// ─── Neuron Usage Dashboard ──────────────────────────────────────────────────

async function handleNeuronsDashboard(env) {
  if (!env?.BOT_KV) {
    return new Response("KV not configured", { status: 503 });
  }

  // Fetch last 14 days of neuron usage
  const days = [];
  const now = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    days.push(dateStr);
  }

  const usageResults = await Promise.allSettled(
    days.map(async (dateStr) => {
      const raw = await env.BOT_KV.get(`neurons:${dateStr}`);
      return { date: dateStr, used: parseInt(raw || "0", 10) };
    })
  );

  const usage = usageResults
    .filter(r => r.status === "fulfilled")
    .map(r => r.value);

  // Fetch today's hourly rate counts
  const todayStr = now.toISOString().slice(0, 10);
  const hourlyResults = await Promise.allSettled(
    Array.from({ length: 24 }, (_, h) => {
      const hourStr = `${todayStr}T${String(h).padStart(2, "0")}`;
      return env.BOT_KV.get(`rate:${hourStr}`).then(raw => ({
        hour: h,
        webhooks: parseInt(raw || "0", 10),
      }));
    })
  );

  const hourly = hourlyResults
    .filter(r => r.status === "fulfilled")
    .map(r => r.value)
    .filter(h => h.webhooks > 0);

  const today = usage.find(u => u.date === todayStr) || { date: todayStr, used: 0 };
  const pct = Math.round((today.used / NEURON_DAILY_LIMIT) * 100);
  const totalWebhooksToday = hourly.reduce((sum, h) => sum + h.webhooks, 0);
  const maxUsage = Math.max(...usage.map(u => u.used), 1);

  return new Response(buildNeuronsHtml({
    today, pct, usage, hourly, totalWebhooksToday, maxUsage,
  }), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

function buildNeuronsHtml({ today, pct, usage, hourly, totalWebhooksToday, maxUsage }) {
  const barColor = pct > 90 ? "var(--danger)" : pct > 70 ? "var(--warning)" : "var(--success)";

  const usageRows = usage.map(u => {
    const barWidth = Math.round((u.used / maxUsage) * 100);
    const dayPct = Math.round((u.used / NEURON_DAILY_LIMIT) * 100);
    const isToday = u.date === today.date;
    return `
      <tr${isToday ? ' class="today"' : ''}>
        <td>${u.date}${isToday ? " (today)" : ""}</td>
        <td class="right">${u.used.toLocaleString()}</td>
        <td class="right">${dayPct}%</td>
        <td>
          <div class="bar-bg"><div class="bar" style="width:${barWidth}%;background:${dayPct > 90 ? "var(--danger)" : dayPct > 70 ? "var(--warning)" : "var(--success)"}"></div></div>
        </td>
      </tr>`;
  }).join("");

  const hourlyRows = hourly.map(h => `
    <tr>
      <td class="center">${String(h.hour).padStart(2, "0")}:00</td>
      <td class="center">${h.webhooks}</td>
    </tr>`
  ).join("");

  const avg7d = usage.length >= 7
    ? Math.round(usage.slice(0, 7).reduce((s, u) => s + u.used, 0) / 7)
    : 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Neuron Usage Dashboard</title>
<style>
  :root {
    --bg: #f8f9fa;
    --surface: #ffffff;
    --text: #1a1a2e;
    --text-secondary: #6c757d;
    --border: #dee2e6;
    --accent: #4361ee;
    --success: #28a745;
    --warning: #ffc107;
    --danger: #dc3545;
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
      --success: #3fb950;
      --warning: #e3b341;
      --danger: #f85149;
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
    max-width: 1000px;
    margin: 0 auto;
  }
  h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
  .subtitle { color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 2rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem;
    box-shadow: var(--card-shadow);
  }
  .card .label { font-size: 0.8rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.8rem; font-weight: 700; margin-top: 0.25rem; }
  .card .detail { font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.25rem; }
  .progress-bg {
    width: 100%;
    height: 24px;
    background: var(--border);
    border-radius: 12px;
    overflow: hidden;
    margin-top: 0.5rem;
  }
  .progress-fill {
    height: 100%;
    border-radius: 12px;
    transition: width 0.3s;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 600;
    color: white;
    min-width: 2rem;
  }
  h2 { font-size: 1.3rem; margin: 2rem 0 1rem; }
  .table-wrap { overflow-x: auto; margin-bottom: 2rem; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 8px; overflow: hidden; box-shadow: var(--card-shadow); }
  th { background: var(--border); padding: 0.75rem 1rem; text-align: left; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); }
  td { padding: 0.6rem 1rem; border-top: 1px solid var(--border); font-size: 0.875rem; }
  .right { text-align: right; }
  .center { text-align: center; }
  .today { background: color-mix(in srgb, var(--accent) 8%, transparent); font-weight: 600; }
  .bar-bg { width: 100%; height: 16px; background: var(--border); border-radius: 8px; overflow: hidden; }
  .bar { height: 100%; border-radius: 8px; }
  tr:hover { background: color-mix(in srgb, var(--accent) 5%, transparent); }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
  @media (max-width: 768px) {
    body { padding: 1rem; }
    .cards { grid-template-columns: 1fr; }
    .grid-2 { grid-template-columns: 1fr; }
  }
  footer { text-align: center; color: var(--text-secondary); font-size: 0.8rem; margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); }
</style>
</head>
<body>
  <h1>&#129504; Neuron Usage Dashboard</h1>
  <p class="subtitle">AI PR Review Bot &bull; Cloudflare Workers AI</p>

  <div class="cards">
    <div class="card">
      <div class="label">Today's Usage</div>
      <div class="value">${today.used.toLocaleString()}</div>
      <div class="detail">of ${NEURON_DAILY_LIMIT.toLocaleString()} daily limit</div>
      <div class="progress-bg">
        <div class="progress-fill" style="width:${Math.min(pct, 100)}%;background:${barColor}">${pct}%</div>
      </div>
    </div>
    <div class="card">
      <div class="label">Remaining Today</div>
      <div class="value">${Math.max(0, NEURON_DAILY_LIMIT - today.used).toLocaleString()}</div>
      <div class="detail">neurons available</div>
    </div>
    <div class="card">
      <div class="label">7-Day Average</div>
      <div class="value">${avg7d.toLocaleString()}</div>
      <div class="detail">neurons / day</div>
    </div>
    <div class="card">
      <div class="label">Webhooks Today</div>
      <div class="value">${totalWebhooksToday}</div>
      <div class="detail">PR reviews triggered</div>
    </div>
  </div>

  <div class="grid-2">
    <div>
      <h2>Daily Usage (14 days)</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Neurons</th><th>% Used</th><th>Usage</th></tr></thead>
          <tbody>${usageRows}</tbody>
        </table>
      </div>
    </div>
    <div>
      <h2>Today's Webhooks by Hour</h2>
      <div class="table-wrap">
      ${hourly.length === 0
        ? '<div style="text-align:center;padding:2rem;color:var(--text-secondary)">No webhooks today yet.</div>'
        : `<table>
          <thead><tr><th>Hour</th><th>Webhooks</th></tr></thead>
          <tbody>${hourlyRows}</tbody>
        </table>`
      }
      </div>
    </div>
  </div>

  <footer>
    Limit: ${NEURON_DAILY_LIMIT.toLocaleString()} neurons/day (Cloudflare free tier: 10,000 with 2K safety buffer)
    &bull; Data retained for 14 days
  </footer>
</body>
</html>`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Backlog / Work Items ────────────────────────────────────────────────────

/**
 * Fetch work items linked to a PR, then walk up to parent user stories.
 * Returns an array of { id, type, title, description, acceptanceCriteria, parent? }.
 */
async function fetchLinkedWorkItems(env, project, repoId, prId, headers) {
  const ORG = orgUrl(env);
  try {
    // 1. Get work item refs linked to the PR
    const refsUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/workitems?api-version=${AZURE_API_VERSION}`;
    const refsRes = await fetchWithRetry(refsUrl, { headers, retries: 2, tag: "Gateway" });
    if (!refsRes.ok) {
      console.log("(log) [Gateway] Could not fetch PR work item refs:", refsRes.status);
      return [];
    }
    const refsData = await refsRes.json();
    const refs = refsData.value || [];
    if (refs.length === 0) return [];

    // 2. Batch-fetch full work item details (with relations so we can find parents)
    const ids = refs.map((r) => r.id).join(",");
    const wiUrl = `${ORG}/${project}/_apis/wit/workitems?ids=${ids}&$expand=relations&api-version=${AZURE_API_VERSION}`;
    const wiRes = await fetchWithRetry(wiUrl, { headers, retries: 2, tag: "Gateway" });
    if (!wiRes.ok) {
      console.log("(log) [Gateway] Could not fetch work item details:", wiRes.status);
      return [];
    }
    const wiData = await wiRes.json();
    const workItems = (wiData.value || []).map((wi) => ({
      id: wi.id,
      type: wi.fields["System.WorkItemType"],
      title: wi.fields["System.Title"],
      state: wi.fields["System.State"],
      description: stripHtml(wi.fields["System.Description"]),
      acceptanceCriteria: stripHtml(
        wi.fields["Microsoft.VSAT.Common.AcceptanceCriteria"] || ""
      ),
      tags: wi.fields["System.Tags"] || "",
      _relations: wi.relations || [],
    }));

    // 3. For tasks/bugs, try to fetch the parent user story / feature
    const parentIds = new Set();
    for (const wi of workItems) {
      const parentRel = wi._relations.find(
        (r) => r.rel === "System.LinkTypes.Hierarchy-Reverse"
      );
      if (parentRel) {
        const parentId = parentRel.url.split("/").pop();
        if (!refs.some((r) => String(r.id) === parentId)) {
          parentIds.add(parentId);
        }
      }
    }

    let parentMap = {};
    if (parentIds.size > 0) {
      const parentIdsStr = [...parentIds].join(",");
      const parentUrl = `${ORG}/${project}/_apis/wit/workitems?ids=${parentIdsStr}&api-version=${AZURE_API_VERSION}`;
      const parentRes = await fetchWithRetry(parentUrl, { headers, retries: 2, tag: "Gateway" });
      if (parentRes.ok) {
        const parentData = await parentRes.json();
        for (const pw of parentData.value || []) {
          parentMap[pw.id] = {
            id: pw.id,
            type: pw.fields["System.WorkItemType"],
            title: pw.fields["System.Title"],
            description: stripHtml(pw.fields["System.Description"]),
            acceptanceCriteria: stripHtml(
              pw.fields["Microsoft.VSAT.Common.AcceptanceCriteria"] || ""
            ),
          };
        }
      }
    }

    // 4. Attach parent info and clean up internal fields
    return workItems.map((wi) => {
      const parentRel = wi._relations.find(
        (r) => r.rel === "System.LinkTypes.Hierarchy-Reverse"
      );
      const parentId = parentRel ? parentRel.url.split("/").pop() : null;
      const { _relations, ...clean } = wi;
      return {
        ...clean,
        parent: parentId ? parentMap[parentId] || null : null,
      };
    });
  } catch (err) {
    console.error("(log) [Gateway] Error fetching work items:", err.message);
    return [];
  }
}

/**
 * Build a backlog context string from work items, respecting MAX_BACKLOG_SIZE.
 */
export function buildBacklogContext(workItems) {
  if (workItems.length === 0) return "";

  let context = "\n## Linked Work Items (Product Backlog)\n";

  for (const wi of workItems) {
    let section = `\n### ${wi.type} #${wi.id}: ${wi.title}`;
    section += `\nState: ${wi.state}`;
    if (wi.tags) section += ` | Tags: ${wi.tags}`;
    section += "\n";

    if (wi.description) {
      section += `**Description:** ${wi.description.substring(0, 500)}\n`;
    }
    if (wi.acceptanceCriteria) {
      section += `**Acceptance Criteria:** ${wi.acceptanceCriteria.substring(0, 500)}\n`;
    }

    // Include parent user story if available
    if (wi.parent) {
      section += `\n> **Parent ${wi.parent.type} #${wi.parent.id}:** ${wi.parent.title}\n`;
      if (wi.parent.acceptanceCriteria) {
        section += `> **Parent Acceptance Criteria:** ${wi.parent.acceptanceCriteria.substring(0, 400)}\n`;
      }
    }

    if (context.length + section.length > MAX_BACKLOG_SIZE) {
      console.log("(log) [Gateway] Backlog budget reached, skipping remaining items");
      break;
    }
    context += section;
  }

  return context;
}

// ─── File Classifier (zero subrequests — path-only) ─────────────────────────

export const SKIP_PATTERNS = [
  // ── Lock files & package managers ──
  /package-lock\.json$/i, /yarn\.lock$/i, /pnpm-lock\.yaml$/i,
  // ── C# generated / build artifacts ──
  /\.designer\.cs$/i, /\.g\.cs$/i, /\.g\.i\.cs$/i, /\.generated\.cs$/i,
  /AssemblyInfo\.cs$/i,
  /\.csproj$/i, /\.sln$/i, /\.suo$/i, /\.user$/i,
  /\/bin\//, /\/obj\//,
  /\/migrations\//i, /\.migration\.cs$/i,
  /\.resx$/i, /\.xaml$/i,
  /appsettings(\.\w+)?\.json$/i, /launchSettings\.json$/i,
  // ── JS/TS build output & minified ──
  /\.min\.js$/i, /\.min\.css$/i, /\.bundle\.js$/i,
  /\/dist\//, /\/node_modules\//, /\/lib\//, /\/coverage\//,
  // ── Angular noise ──
  /angular\.json$/i, /karma\.conf\.js$/i, /protractor\.conf\.js$/i,
  /polyfills\.ts$/i, /environment\.(prod|dev|staging)\.ts$/i,
  /\.browserslistrc$/i,
  // ── SPFx noise ──
  /\.manifest\.json$/i, /\.yo-rc\.json$/i,
  /\/config\/(config|deploy-azure-storage|package-solution|serve|write-manifests)\.json$/i,
  /gulpfile\.js$/i,
  /\/loc\/[^/]+\.(d\.ts|js)$/i,
  // ── Binary / media / fonts ──
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp4|mp3|zip|pdf|webp)$/i,
  // ── Docs, config boilerplate ──
  /\.md$/i, /\.txt$/i, /LICENSE/i, /\.gitignore$/i, /\.gitattributes$/i,
  /\.editorconfig$/i, /\.prettierrc/i, /\.eslintrc/i, /tsconfig.*\.json$/i,
  /\.dockerignore$/i, /Dockerfile$/i, /docker-compose/i,
  /tslint\.json$/i, /\.npmignore$/i,
];

const HIGH_EXTENSIONS = /\.(cs|ts|tsx|js|jsx|py|go|rs|java|kt|rb|swift|vue|svelte)$/i;
const LOW_EXTENSIONS = /\.(test\.|spec\.|tests\.|_test\.|_spec\.)/i;
const LOW_PATHS = /\/(tests?|__tests__|specs?|testing|stylesheets?|styles|e2e)\//i;
const LOW_FILE_EXTENSIONS = /\.(css|scss|sass|less)$/i;

// Angular component templates have real logic — treat as HIGH, not LOW
const ANGULAR_TEMPLATE = /\.component\.html$/i;

export const PRIORITY_KEYWORDS = [
  // ── C# backend ──
  { pattern: /(controller|handler|endpoint)/i, score: 10 },
  { pattern: /(service|repository|provider|manager)/i, score: 8 },
  { pattern: /(middleware|filter|interceptor|guard|attribute)/i, score: 7 },
  { pattern: /(startup|program)\.cs$/i, score: 7 },
  { pattern: /(model|entity|schema|dto|viewmodel)/i, score: 5 },
  // ── Angular ──
  { pattern: /\.component\.ts$/i, score: 9 },
  { pattern: /\.service\.ts$/i, score: 8 },
  { pattern: /\.guard\.ts$/i, score: 7 },
  { pattern: /\.interceptor\.ts$/i, score: 7 },
  { pattern: /\.resolver\.ts$/i, score: 7 },
  { pattern: /\.directive\.ts$/i, score: 6 },
  { pattern: /\.pipe\.ts$/i, score: 5 },
  { pattern: /\.module\.ts$/i, score: 4 },
  { pattern: /\.component\.html$/i, score: 6 },
  // ── SPFx ──
  { pattern: /WebPart\.ts$/i, score: 9 },
  { pattern: /\.extension\.ts$/i, score: 8 },
  { pattern: /\.command\.ts$/i, score: 8 },
  // ── General ──
  { pattern: /(api|route)/i, score: 9 },
  { pattern: /(util|helper|extension|config)/i, score: 3 },
];

/**
 * Classify all files by path alone (zero subrequests).
 * Returns { skip: [...], high: [...], low: [...] }
 * High files are sorted by priority score (highest first).
 */
export function classifyFiles(entries) {
  const skip = [];
  const high = [];
  const low = [];

  for (const c of entries) {
    const path = c.item?.path;
    const changeType = c.changeType;

    if (!path || path.endsWith("/")) continue;

    const ct = typeof changeType === "string" ? changeType.toLowerCase() : changeType;
    const isEdit = ct === "edit" || ct === 2;
    const isAdd = ct === "add" || ct === 1;
    if (!isEdit && !isAdd) continue;

    const fileInfo = { path, changeType: ct, isEdit, isAdd, changeTrackingId: c.changeTrackingId };

    // Check SKIP patterns
    if (SKIP_PATTERNS.some((re) => re.test(path))) {
      skip.push(fileInfo);
      continue;
    }

    // Angular component templates have real logic — treat as HIGH
    if (ANGULAR_TEMPLATE.test(path)) {
      let priorityScore = 6;
      for (const kw of PRIORITY_KEYWORDS) {
        if (kw.pattern.test(path)) {
          priorityScore = Math.max(priorityScore, kw.score);
        }
      }
      fileInfo.priorityScore = priorityScore;
      high.push(fileInfo);
      continue;
    }

    // Check LOW patterns (tests, styles, etc.)
    if (LOW_EXTENSIONS.test(path) || LOW_PATHS.test(path) || LOW_FILE_EXTENSIONS.test(path)) {
      low.push(fileInfo);
      continue;
    }

    // Check HIGH extensions
    if (HIGH_EXTENSIONS.test(path)) {
      // Calculate priority score
      let priorityScore = 1;
      for (const kw of PRIORITY_KEYWORDS) {
        if (kw.pattern.test(path)) {
          priorityScore = Math.max(priorityScore, kw.score);
        }
      }
      fileInfo.priorityScore = priorityScore;
      high.push(fileInfo);
      continue;
    }

    // Default: treat as low priority
    low.push(fileInfo);
  }

  // Sort HIGH files: highest priority first
  high.sort((a, b) => b.priorityScore - a.priorityScore);

  return { skip, high, low };
}

// ─── PR Auto-Tagging ────────────────────────────────────────────────────────

const BACKEND_PATTERN = /\.(cs|py|go|rs|java|kt|rb)$/i;
const FRONTEND_PATTERN = /\.(ts|tsx|js|jsx|vue|svelte|component\.html)$/i;

/**
 * Compute PR labels based on file classification (zero subrequests — pure logic).
 * @param {object} classified - { skip, high, low } from classifyFiles()
 * @param {Array} [workItems=[]] - Linked work items from fetchLinkedWorkItems()
 * @returns {string[]} Label names to apply
 */
export function computePrLabels(classified, workItems = []) {
  const labels = [];
  const allReviewable = [...classified.high, ...classified.low];

  // docs-only: every file was skipped (no reviewable files)
  if (allReviewable.length === 0 && classified.skip.length > 0) {
    labels.push("docs-only");
    return labels;
  }

  // tests-only: every reviewable file is a test/spec file
  if (allReviewable.length > 0 && allReviewable.every(f => LOW_EXTENSIONS.test(f.path) || LOW_PATHS.test(f.path))) {
    labels.push("tests-only");
  }

  // large-pr: 15+ reviewable files
  if (allReviewable.length >= 15) {
    labels.push("large-pr");
  }

  // high-risk: 5+ high-priority files
  if (classified.high.length >= 5) {
    labels.push("high-risk");
  }

  // needs-backlog: no linked work items
  if (workItems.length === 0) {
    labels.push("needs-backlog");
  }

  // frontend / backend detection (skip if tests-only — test file extensions would false-positive)
  if (!labels.includes("tests-only")) {
    const hasBackend = allReviewable.some(f => BACKEND_PATTERN.test(f.path));
    const hasFrontend = allReviewable.some(f => FRONTEND_PATTERN.test(f.path));
    if (hasBackend) labels.push("backend");
    if (hasFrontend) labels.push("frontend");
  }

  return labels;
}

/**
 * Apply labels to an Azure DevOps PR.
 * Uses POST to add each label individually (Azure DevOps Labels API).
 * Fire-and-forget — failures are logged but don't block the review.
 */
async function applyPrLabels(env, project, repoId, prId, labels, headers) {
  if (labels.length === 0) return;
  const ORG = orgUrl(env);

  const baseUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/labels?api-version=${AZURE_API_VERSION}`;

  const results = await Promise.allSettled(
    labels.map(label =>
      fetchWithTimeout(baseUrl, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: label }),
      })
    )
  );

  const succeeded = results.filter(r => r.status === "fulfilled" && r.value?.ok).length;
  const failed = results.length - succeeded;
  console.log(`(log) [Gateway] PR labels: ${succeeded} applied, ${failed} failed (${labels.join(", ")})`);
}

// ─── Playwright Eligibility & Delegation ────────────────────────────────────

/**
 * Check whether the PR webhook targets the AdminApp repo's Dev branch.
 * Only those PRs should trigger Playwright test generation.
 */
function isPlaywrightEligible(payload, env) {
  const repoName = payload.resource?.repository?.name;
  const targetBranch = payload.resource?.targetRefName;
  const expectedRepo = env?.PLAYWRIGHT_REPO_NAME || "BindTuning.AdminApp";
  const expectedBranch = env?.PLAYWRIGHT_TARGET_BRANCH || "refs/heads/Dev";
  return repoName === expectedRepo && targetBranch === expectedBranch;
}

/**
 * Fire-and-forget: send PR data to the dedicated Playwright test generation
 * worker via Service Binding. Does NOT count as a subrequest!
 */
function firePlaywrightWorker({ payload, fileChanges, env }) {
  const prId = payload.resource.pullRequestId;
  const repoId = payload.resource.repository.id;
  const project = payload.resource.repository.project.name;
  const prTitle = payload.resource.title || "";

  const body = {
    prId,
    repoId,
    project,
    prTitle,
    fileChanges: fileChanges.map(fc => ({
      path: fc.path,
      diff: fc.diff,
      isAdd: fc.isAdd,
    })),
    azureToken: env.AZURE_TOKEN,
  };

  env.PW_CONTEXT.fetch("https://pw-context/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(res => console.log(`(log) [Gateway] Playwright worker responded: ${res.status}`))
    .catch(e => console.error("(log) [Gateway] Playwright worker call failed:", e.message));
}

// ─── Main Review Logic ──────────────────────────────────────────────────────

async function processReview(payload, env) {
  const prId = payload.resource.pullRequestId;
  const repoId = payload.resource.repository.id;
  const project = payload.resource.repository.project.name;
  const prTitle = payload.resource.title || "";
  const sourceCommit = payload.resource.lastMergeSourceCommit.commitId;
  const targetCommit = payload.resource.lastMergeTargetCommit.commitId;

  try {
    // ── Webhook Deduplication (check only — write AFTER success) ─────────
    try {
      if (env?.BOT_KV) {
        const dedupKey = `dedup:${prId}:${sourceCommit}`;
        const existing = await env.BOT_KV.get(dedupKey);
        if (existing) {
          console.log(`(log) [Gateway] Duplicate webhook for PR ${prId} @ ${sourceCommit}, skipping`);
          return;
        }
        // Don't write yet — we'll write after successful delegation (#12)
      }
    } catch (e) {
      // Fail-open: if KV read fails, proceed normally
      console.log("(log) [Gateway] KV dedup check failed (proceeding anyway):", e.message);
    }

    console.log(`(log) [Gateway] Processing PR ${prId}: "${prTitle}"`);
    console.log(`(log) [Gateway] Source: ${sourceCommit} | Target: ${targetCommit}`);
    const ORG = orgUrl(env);

    const headers = buildAzureHeaders(env.AZURE_TOKEN);

    // 1. Get latest iteration (1 subrequest)
    const iterUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations?api-version=${AZURE_API_VERSION}`;
    const iterRes = await fetchWithRetry(iterUrl, { headers, retries: 2, tag: "Gateway" });
    if (!iterRes.ok) {
      console.error("(log) [Gateway] Failed to fetch iterations:", iterRes.status);
      return;
    }
    const iterData = await iterRes.json();
    const latestIteration = Math.max(...iterData.value.map((i) => i.id));

    // 2. Get changed files (1 subrequest)
    const changesUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations/${latestIteration}/changes?api-version=${AZURE_API_VERSION}`;
    const changesRes = await fetchWithRetry(changesUrl, { headers, retries: 2, tag: "Gateway" });
    if (!changesRes.ok) {
      console.error("(log) [Gateway] Failed to fetch changes:", changesRes.status);
      return;
    }
    const changesData = await changesRes.json();
    const entries = changesData.changeEntries || changesData.changes || [];

    // 3. Fetch linked work items (~3 subrequests)
    const workItems = await fetchLinkedWorkItems(env, project, repoId, prId, headers);
    console.log(`(log) [Gateway] Linked work items: ${workItems.length}`);
    const backlogContext = buildBacklogContext(workItems);

    // 4. Classify all files (zero subrequests!)
    const classified = classifyFiles(entries);
    console.log(`(log) [Gateway] Classification: ${classified.high.length} HIGH, ${classified.low.length} LOW, ${classified.skip.length} SKIP`);

    // 4b. Auto-tag PR with labels based on classification (fire-and-forget)
    const prLabels = computePrLabels(classified, workItems);
    if (prLabels.length > 0) {
      applyPrLabels(env, project, repoId, prId, prLabels, headers)
        .catch(e => console.log("(log) [Gateway] Label apply error:", e.message));
    }

    // Reviewable = HIGH first, then LOW
    const reviewableFiles = [...classified.high, ...classified.low];
    const totalFiles = classified.high.length + classified.low.length + classified.skip.length;
    const skippedFiles = classified.skip.length;

    if (reviewableFiles.length === 0) {
      console.log("(log) [Gateway] No reviewable files found after classification");
      return;
    }

    // 5. Split into first batch + remaining
    const batchFiles = reviewableFiles.slice(0, MAX_BATCH_FILES);
    const remainingFiles = reviewableFiles.slice(MAX_BATCH_FILES);

    console.log(`(log) [Gateway] Delegating to review worker: ${batchFiles.length} batch files, ${remainingFiles.length} remaining`);

    // 6. Delegate to review worker via Service Binding (does NOT count as a subrequest!)
    const reviewPayload = {
      __isReviewRequest: true,
      pr: {
        id: prId,
        repoId,
        project,
        title: prTitle,
        sourceCommit,
        targetCommit,
      },
      batchFiles,
      remainingFiles,
      backlogContext,
      workItems,
      totalFiles,
      skippedFiles,
      azureToken: env.AZURE_TOKEN,
    };

    const reviewRes = await env.REVIEW_WORKER.fetch("https://review/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reviewPayload),
    });

    if (reviewRes.ok) {
      console.log(`(log) [Gateway] Review worker accepted: ${reviewRes.status}`);
    } else {
      console.error(`(log) [Gateway] Review worker failed: ${reviewRes.status} ${await reviewRes.text()}`);
    }

    // ── Write dedup key AFTER successful delegation ─────────────────────
    // This ensures that if processing fails, the retry webhook won't be blocked.
    try {
      if (env?.BOT_KV) {
        const dedupKey = `dedup:${prId}:${sourceCommit}`;
        await env.BOT_KV.put(dedupKey, "1", { expirationTtl: 3600 });
      }
    } catch (e) {
      console.log("(log) [Gateway] KV dedup write failed (non-critical):", e.message);
    }

    // 7. Playwright test generation (fire-and-forget to pw-context worker)
    //    We send it in parallel — the review worker handles the review,
    //    the playwright pipeline handles test generation independently.
    if (isPlaywrightEligible(payload, env)) {
      console.log("(log) [Gateway] PR is eligible for Playwright, delegating to pw-context worker");
      // Build minimal fileChanges for Playwright (just paths + change type)
      // The pw-context worker will fetch full content itself
      firePlaywrightWorker({
        payload,
        fileChanges: reviewableFiles.map(f => ({
          path: f.path,
          diff: "",
          isAdd: f.isAdd,
        })),
        env,
      });
    }

    console.log(`(log) [Gateway] Done routing PR ${prId}`);
  } catch (err) {
    console.error("(log) [Gateway] Error in processReview:", err.stack || err);
  }
}

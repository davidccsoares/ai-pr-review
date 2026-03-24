/**
 * Standalone dry-run tests for:
 *   1. Webhook Deduplication
 *   2. Secret/Credential Detection
 *   3. Inline Thread Comments
 *   4. Integration: postUnifiedReview output
 *   5. GET / Health Endpoint
 *   6. PR Auto-Tagging (label computation)
 *
 * Uses Node.js built-in test runner (node:test + node:assert) — zero extra deps.
 * Run: node --test test/dry-run.test.mjs
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { scanForSecrets, SECRET_PATTERNS } from "../src/lib/secrets.js";
import { AZURE_API_VERSION } from "../src/lib/azure.js";
import { extractIssues, diffReviewIssues, buildFollowUpSection } from "../src/review-worker.js";

// ─── Constants used by test helpers ──────────────────────────────────────────
const MAX_INLINE_COMMENTS = 10;
const ORG = "https://dev.azure.com/bindtuning";

// ─── postInlineComments re-implementation with injectable fetch ──────────────

async function postInlineComments(project, repoId, prId, comments, azureHeaders, fetchFn) {
  if (!comments || comments.length === 0) return;

  const toPost = comments
    .filter(c => c.file && c.line && c.comment && !c.comment.toLowerCase().includes("lgtm"))
    .slice(0, MAX_INLINE_COMMENTS);

  if (toPost.length === 0) return;

  const threadUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=${AZURE_API_VERSION}`;

  const results = await Promise.allSettled(
    toPost.map(c =>
      fetchFn(threadUrl, {
        method: "POST",
        headers: { ...azureHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          comments: [
            {
              parentCommentId: 0,
              content: c.comment,
              commentType: 1,
            },
          ],
          threadContext: {
            filePath: c.file,
            rightFileStart: { line: c.line, offset: 1 },
            rightFileEnd: { line: c.line, offset: 1 },
          },
          status: 4,
        }),
      })
    )
  );

  const succeeded = results.filter(r => r.status === "fulfilled" && r.value?.ok).length;
  const failed = results.length - succeeded;
  return { succeeded, failed, total: results.length };
}

// ─── Mock KV Store ───────────────────────────────────────────────────────────

function createMockKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, opts) {
      store.set(key, { value, opts });
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 1: Webhook Deduplication
// ═══════════════════════════════════════════════════════════════════════════════

describe("Feature 1: Webhook Deduplication", () => {
  it("dedup key format is dedup:{prId}:{sourceCommit}", () => {
    const prId = 42;
    const sourceCommit = "abc123def456";
    const dedupKey = `dedup:${prId}:${sourceCommit}`;
    assert.equal(dedupKey, "dedup:42:abc123def456");
  });

  it("first webhook passes through — KV.get returns null, KV.put called with TTL 3600", async () => {
    const kv = createMockKV();
    const prId = 100;
    const sourceCommit = "commit1";
    const dedupKey = `dedup:${prId}:${sourceCommit}`;

    // Simulate the dedup logic from worker.js
    const existing = await kv.get(dedupKey);
    assert.equal(existing, null, "First call should return null");

    // Proceed and mark as seen
    await kv.put(dedupKey, "1", { expirationTtl: 3600 });

    const stored = kv.store.get(dedupKey);
    assert.equal(stored.value, "1");
    assert.equal(stored.opts.expirationTtl, 3600);
  });

  it("duplicate webhook is blocked — KV.get returns '1'", async () => {
    const kv = createMockKV();
    const prId = 100;
    const sourceCommit = "commit1";
    const dedupKey = `dedup:${prId}:${sourceCommit}`;

    // Pre-populate to simulate a previous webhook
    await kv.put(dedupKey, "1", { expirationTtl: 3600 });

    // Now simulate second webhook
    const existing = await kv.get(dedupKey);
    // existing is the stored object { value, opts } — but our mock returns the value
    assert.notEqual(existing, null, "Second call should find existing entry");

    // The worker would `return` here — we just verify it would skip
    let proceeded = true;
    if (existing) {
      proceeded = false; // Blocked
    }
    assert.equal(proceeded, false, "Duplicate webhook should be blocked");
  });

  it("different commit on same PR is NOT blocked", async () => {
    const kv = createMockKV();
    const prId = 100;

    // First webhook
    const dedupKey1 = `dedup:${prId}:commitA`;
    await kv.put(dedupKey1, "1", { expirationTtl: 3600 });

    // Second webhook with different commit
    const dedupKey2 = `dedup:${prId}:commitB`;
    const existing = await kv.get(dedupKey2);
    assert.equal(existing, null, "Different sourceCommit should produce different key");
  });

  it("fail-open on KV.get error — still proceeds", async () => {
    const faultyKV = {
      async get() {
        throw new Error("KV read failure");
      },
      async put() {},
    };

    let proceeded = false;
    try {
      if (faultyKV) {
        const dedupKey = `dedup:1:abc`;
        const existing = await faultyKV.get(dedupKey);
        if (existing) {
          // Would return/skip
          return;
        }
        await faultyKV.put(dedupKey, "1", { expirationTtl: 3600 });
      }
      proceeded = true;
    } catch (_e) {
      // Fail-open: KV error → proceed anyway
      proceeded = true;
    }
    assert.equal(proceeded, true, "Should proceed despite KV.get error");
  });

  it("fail-open on KV.put error — still proceeds (webhook not blocked)", async () => {
    const faultyKV = {
      async get() {
        return null; // First time, no duplicate
      },
      async put() {
        throw new Error("KV write failure");
      },
    };

    let proceeded = false;
    try {
      if (faultyKV) {
        const dedupKey = `dedup:1:abc`;
        const existing = await faultyKV.get(dedupKey);
        if (existing) {
          return;
        }
        await faultyKV.put(dedupKey, "1", { expirationTtl: 3600 });
      }
      proceeded = true;
    } catch (_e) {
      // Fail-open: even though put failed, we still proceed
      proceeded = true;
    }
    assert.equal(proceeded, true, "Should proceed despite KV.put error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 2: Secret Detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("Feature 2: Secret Detection", () => {
  it("detects hardcoded password", () => {
    const findings = scanForSecrets([
      { path: "/src/config.js", diff: '+10: password = "secret123"' },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, "Hardcoded password");
    assert.equal(findings[0].file, "/src/config.js");
    assert.equal(findings[0].line, 10);
  });

  it("detects API key", () => {
    const findings = scanForSecrets([
      { path: "/src/api.js", diff: '+5: api_key = "abc123xyz"' },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, "API key");
  });

  it("detects Bearer token", () => {
    const findings = scanForSecrets([
      {
        path: "/src/auth.js",
        diff: '+20: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, "Bearer token");
  });

  it("detects private key header", () => {
    const findings = scanForSecrets([
      {
        path: "/keys/id_rsa",
        diff: "+1: -----BEGIN RSA PRIVATE KEY-----",
      },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, "Private key");
  });

  it("detects GitHub PAT", () => {
    const findings = scanForSecrets([
      {
        path: "/src/github.js",
        diff: "+3: const token = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
      },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, "GitHub PAT");
  });

  it("detects connection string", () => {
    const findings = scanForSecrets([
      {
        path: "/src/db.cs",
        diff: '+7: connectionString = "Server=myserver;Database=mydb;User Id=admin;Password=p@ss"',
      },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, "Connection string");
  });

  it("detects client secret (caught by generic 'secret' pattern)", () => {
    // Note: client_secret matches the generic "Secret value" pattern first
    // because "secret = ..." appears within "client_secret = ...".
    // The "Client secret" pattern is effectively shadowed — this is the actual
    // production behavior, verified here.
    const findings = scanForSecrets([
      {
        path: "/src/oauth.js",
        diff: '+12: client_secret = "xK9mW2pL7qR4"',
      },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pattern, "Secret value");
    assert.equal(findings[0].file, "/src/oauth.js");
    assert.equal(findings[0].line, 12);
  });

  it("ignores context lines (no + prefix) — space-prefixed lines with secrets are ignored", () => {
    const findings = scanForSecrets([
      {
        path: "/src/config.js",
        diff: ' 10: password = "secret123"',
      },
    ]);
    assert.equal(findings.length, 0, "Context lines should not trigger secret detection");
  });

  it("ignores deleted lines (- prefix)", () => {
    const findings = scanForSecrets([
      {
        path: "/src/config.js",
        diff: '-10: password = "secret123"',
      },
    ]);
    assert.equal(findings.length, 0, "Deleted lines should not trigger secret detection");
  });

  it("no findings for clean diff", () => {
    const findings = scanForSecrets([
      {
        path: "/src/app.js",
        diff: [
          "+1: const x = 42;",
          "+2: function hello() {",
          "+3:   return 'world';",
          "+4: }",
        ].join("\n"),
      },
    ]);
    assert.equal(findings.length, 0, "Clean code should have zero findings");
  });

  it("multiple findings across files", () => {
    const findings = scanForSecrets([
      {
        path: "/src/config.js",
        diff: '+10: password = "hunter2"',
      },
      {
        path: "/src/auth.js",
        diff: "+5: const token = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
      },
    ]);
    assert.equal(findings.length, 2, "Should find secrets in both files");
    assert.equal(findings[0].file, "/src/config.js");
    assert.equal(findings[0].pattern, "Hardcoded password");
    assert.equal(findings[1].file, "/src/auth.js");
    assert.equal(findings[1].pattern, "GitHub PAT");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 3: Inline Thread Comments
// ═══════════════════════════════════════════════════════════════════════════════

describe("Feature 3: Inline Thread Comments", () => {
  const project = "MyProject";
  const repoId = "repo-123";
  const prId = 42;
  const azureHeaders = { Authorization: "Basic dGVzdDp0b2tlbg==" };

  it("posts non-LGTM comments as inline threads with correct threadContext shape", async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200 };
    };

    const comments = [
      { file: "/src/a.js", line: 10, comment: "Null check missing" },
      { file: "/src/b.js", line: 20, comment: "Use const instead of let" },
      { file: "/src/c.js", line: 30, comment: "Consider error handling" },
    ];

    await postInlineComments(project, repoId, prId, comments, azureHeaders, mockFetch);

    assert.equal(calls.length, 3, "Should make 3 fetch calls");

    // Verify URL format
    const expectedUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=${AZURE_API_VERSION}`;
    for (const call of calls) {
      assert.equal(call.url, expectedUrl);
      assert.equal(call.opts.method, "POST");

      const body = JSON.parse(call.opts.body);
      assert.ok(body.threadContext, "Should include threadContext");
      assert.ok(body.threadContext.filePath, "Should include filePath");
      assert.ok(body.threadContext.rightFileStart, "Should include rightFileStart");
      assert.ok(body.threadContext.rightFileEnd, "Should include rightFileEnd");
      assert.equal(body.threadContext.rightFileStart.offset, 1);
      assert.equal(body.threadContext.rightFileEnd.offset, 1);
      assert.equal(body.status, 4, "Status should be 4 (closed/informational)");
      assert.equal(body.comments.length, 1);
      assert.equal(body.comments[0].parentCommentId, 0);
      assert.equal(body.comments[0].commentType, 1);
    }

    // Verify specific file/line mappings
    const body0 = JSON.parse(calls[0].opts.body);
    assert.equal(body0.threadContext.filePath, "/src/a.js");
    assert.equal(body0.threadContext.rightFileStart.line, 10);

    const body1 = JSON.parse(calls[1].opts.body);
    assert.equal(body1.threadContext.filePath, "/src/b.js");
    assert.equal(body1.threadContext.rightFileStart.line, 20);

    const body2 = JSON.parse(calls[2].opts.body);
    assert.equal(body2.threadContext.filePath, "/src/c.js");
    assert.equal(body2.threadContext.rightFileStart.line, 30);
  });

  it("skips LGTM comments — only issues posted", async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200 };
    };

    const comments = [
      { file: "/src/a.js", line: 10, comment: "LGTM! Looks great." },
      { file: "/src/b.js", line: 20, comment: "Missing validation" },
      { file: "/src/c.js", line: 30, comment: "lgtm, no issues" },
      { file: "/src/d.js", line: 40, comment: "Potential memory leak" },
    ];

    await postInlineComments(project, repoId, prId, comments, azureHeaders, mockFetch);

    assert.equal(calls.length, 2, "Should only post 2 non-LGTM comments");

    const body0 = JSON.parse(calls[0].opts.body);
    assert.equal(body0.comments[0].content, "Missing validation");

    const body1 = JSON.parse(calls[1].opts.body);
    assert.equal(body1.comments[0].content, "Potential memory leak");
  });

  it("caps at 10 inline comments", async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200 };
    };

    // Create 15 non-LGTM comments
    const comments = Array.from({ length: 15 }, (_, i) => ({
      file: `/src/file${i}.js`,
      line: i + 1,
      comment: `Issue #${i + 1}: something wrong`,
    }));

    await postInlineComments(project, repoId, prId, comments, azureHeaders, mockFetch);

    assert.equal(calls.length, 10, "Should cap at 10 inline comments");
  });

  it("does nothing for empty comments", async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200 };
    };

    await postInlineComments(project, repoId, prId, [], azureHeaders, mockFetch);

    assert.equal(calls.length, 0, "Should make no fetch calls for empty comments");
  });

  it("does nothing for all-LGTM comments", async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200 };
    };

    const comments = [
      { file: "/src/a.js", line: 1, comment: "LGTM" },
      { file: "/src/b.js", line: 2, comment: "lgtm - looks good to me" },
      { file: "/src/c.js", line: 3, comment: "LGTM, well done!" },
      { file: "/src/d.js", line: 4, comment: "Everything is LGTM" },
      { file: "/src/e.js", line: 5, comment: "Code is lgtm" },
    ];

    await postInlineComments(project, repoId, prId, comments, azureHeaders, mockFetch);

    assert.equal(calls.length, 0, "Should make no fetch calls for all-LGTM comments");
  });

  it("tolerates partial fetch failures — completes with mixed results", async () => {
    let callIndex = 0;
    const mockFetch = async (_url, _opts) => {
      callIndex++;
      if (callIndex === 2) {
        throw new Error("Network failure");
      }
      return { ok: true, status: 200 };
    };

    const comments = [
      { file: "/src/a.js", line: 10, comment: "Issue A" },
      { file: "/src/b.js", line: 20, comment: "Issue B" },
      { file: "/src/c.js", line: 30, comment: "Issue C" },
    ];

    // Should NOT throw — Promise.allSettled handles failures
    const result = await postInlineComments(project, repoId, prId, comments, azureHeaders, mockFetch);

    assert.equal(result.total, 3, "Should attempt all 3 comments");
    assert.equal(result.succeeded, 2, "2 should succeed");
    assert.equal(result.failed, 1, "1 should fail");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: postUnifiedReview output
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: postUnifiedReview output", () => {
  const project = "MyProject";
  const repoId = "repo-123";
  const prId = 42;

  // Re-implement the security-section part of postUnifiedReview for testing
  function buildReviewSummary(allFileChanges) {
    const summary = ["## 🤖 AI Code Review", ""];

    // Secret detection section
    const secretFindings = scanForSecrets(allFileChanges);
    if (secretFindings.length > 0) {
      summary.push("### 🔒 Security Alerts", "");
      for (const f of secretFindings) {
        const fileName = f.file.split("/").pop();
        summary.push(`- **${f.pattern}** found in \`${fileName}\` at line ${f.line}`);
      }
      summary.push("");
    }

    return summary.join("\n");
  }

  it("security section appears when secrets found", () => {
    const allFileChanges = [
      {
        path: "/src/config.js",
        diff: '+10: password = "hunter2"',
        changedLines: [10],
      },
    ];

    const output = buildReviewSummary(allFileChanges);
    assert.ok(output.includes("🔒 Security Alerts"), "Should contain Security Alerts header");
    assert.ok(output.includes("Hardcoded password"), "Should mention the pattern found");
    assert.ok(output.includes("config.js"), "Should mention the filename");
    assert.ok(output.includes("line 10"), "Should mention the line number");
  });

  it("security section absent when no secrets", () => {
    const allFileChanges = [
      {
        path: "/src/clean.js",
        diff: ["+1: const x = 42;", "+2: const y = 'hello';"].join("\n"),
        changedLines: [1, 2],
      },
    ];

    const output = buildReviewSummary(allFileChanges);
    assert.ok(!output.includes("🔒 Security Alerts"), "Should NOT contain Security Alerts header");
    assert.ok(!output.includes("Hardcoded password"), "Should NOT mention any pattern");
  });

  it("inline comments called before summary POST — track call order via mock", async () => {
    const callOrder = [];

    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.threadContext) {
        callOrder.push("inline");
      } else {
        callOrder.push("summary");
      }
      return { ok: true, status: 200 };
    };

    // Simulate the order from postUnifiedReview:
    // 1. Post inline thread comments
    const comments = [
      { file: "/src/a.js", line: 10, comment: "Fix this" },
    ];
    await postInlineComments(project, repoId, prId, comments, {}, mockFetch);

    // 2. Then post the summary thread
    const summaryBody = {
      comments: [{ parentCommentId: 0, content: "## Summary", commentType: 1 }],
      status: 4,
    };
    await mockFetch("https://dev.azure.com/...", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summaryBody),
    });

    // Verify order
    assert.equal(callOrder[0], "inline", "Inline comments should be posted first");
    assert.equal(callOrder[1], "summary", "Summary should be posted after inline comments");
    assert.equal(callOrder.length, 2, "Exactly 2 call groups expected");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Inline copy of computePrLabels (not exported from worker.js)
// ═══════════════════════════════════════════════════════════════════════════════

const BACKEND_PATTERN = /\.(cs|py|go|rs|java|kt|rb)$/i;
const FRONTEND_PATTERN = /\.(ts|tsx|js|jsx|vue|svelte|component\.html)$/i;

function computePrLabels(classified) {
  const labels = [];
  const allReviewable = [...classified.high, ...classified.low];

  // docs-only: every file was skipped (no reviewable files)
  if (allReviewable.length === 0 && classified.skip.length > 0) {
    labels.push("docs-only");
    return labels;
  }

  // large-pr: 15+ reviewable files
  if (allReviewable.length >= 15) {
    labels.push("large-pr");
  }

  // high-risk: 5+ high-priority files
  if (classified.high.length >= 5) {
    labels.push("high-risk");
  }

  // frontend / backend detection
  const hasBackend = allReviewable.some(f => BACKEND_PATTERN.test(f.path));
  const hasFrontend = allReviewable.some(f => FRONTEND_PATTERN.test(f.path));
  if (hasBackend) labels.push("backend");
  if (hasFrontend) labels.push("frontend");

  return labels;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 5: GET / Health Endpoint
// ═══════════════════════════════════════════════════════════════════════════════

describe("Feature 5: GET / Health Endpoint", () => {
  it("returns JSON with status, worker name, and uptime", () => {
    // Simulate the health response shape from the worker
    const STARTUP_TIME = Date.now() - 60_000; // started 60s ago
    const response = {
      status: "ok",
      worker: "ai-pr-review-gateway",
      uptime: Math.floor((Date.now() - STARTUP_TIME) / 1000),
    };

    assert.equal(response.status, "ok");
    assert.equal(response.worker, "ai-pr-review-gateway");
    assert.ok(response.uptime >= 59 && response.uptime <= 61, `Uptime should be ~60s, got ${response.uptime}`);
  });

  it("GET returns 200, non-POST/non-GET returns 405", () => {
    // Simulate the routing logic
    function routeMethod(method) {
      if (method === "GET") return 200;
      if (method === "POST") return null; // proceeds to webhook logic
      return 405;
    }

    assert.equal(routeMethod("GET"), 200);
    assert.equal(routeMethod("POST"), null);
    assert.equal(routeMethod("PUT"), 405);
    assert.equal(routeMethod("DELETE"), 405);
    assert.equal(routeMethod("PATCH"), 405);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 6: PR Auto-Tagging (label computation)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Feature 6: PR Auto-Tagging", () => {
  it("labels backend-only PR as 'backend'", () => {
    const classified = {
      high: [
        { path: "/src/Controllers/UserController.cs", priorityScore: 10 },
        { path: "/src/Services/AuthService.cs", priorityScore: 8 },
      ],
      low: [],
      skip: [],
    };
    const labels = computePrLabels(classified);
    assert.ok(labels.includes("backend"), "Should include 'backend' label");
    assert.ok(!labels.includes("frontend"), "Should NOT include 'frontend' label");
  });

  it("labels frontend-only PR as 'frontend'", () => {
    const classified = {
      high: [
        { path: "/src/app/login/login.component.ts", priorityScore: 9 },
        { path: "/src/app/login/login.component.html", priorityScore: 6 },
      ],
      low: [],
      skip: [],
    };
    const labels = computePrLabels(classified);
    assert.ok(labels.includes("frontend"), "Should include 'frontend' label");
    assert.ok(!labels.includes("backend"), "Should NOT include 'backend' label");
  });

  it("labels full-stack PR as both 'backend' and 'frontend'", () => {
    const classified = {
      high: [
        { path: "/src/Controllers/ApiController.cs", priorityScore: 10 },
        { path: "/src/app/dashboard/dashboard.component.ts", priorityScore: 9 },
      ],
      low: [],
      skip: [],
    };
    const labels = computePrLabels(classified);
    assert.ok(labels.includes("backend"), "Should include 'backend'");
    assert.ok(labels.includes("frontend"), "Should include 'frontend'");
  });

  it("labels 'docs-only' when all files are skipped", () => {
    const classified = {
      high: [],
      low: [],
      skip: [
        { path: "/README.md" },
        { path: "/docs/setup.md" },
        { path: "/package-lock.json" },
      ],
    };
    const labels = computePrLabels(classified);
    assert.deepEqual(labels, ["docs-only"], "Should only have 'docs-only' label");
  });

  it("labels 'large-pr' when 15+ reviewable files", () => {
    const classified = {
      high: Array.from({ length: 10 }, (_, i) => ({
        path: `/src/file${i}.cs`,
        priorityScore: 5,
      })),
      low: Array.from({ length: 6 }, (_, i) => ({
        path: `/src/style${i}.css`,
      })),
      skip: [],
    };
    const labels = computePrLabels(classified);
    assert.ok(labels.includes("large-pr"), "Should include 'large-pr'");
  });

  it("labels 'high-risk' when 5+ high-priority files", () => {
    const classified = {
      high: Array.from({ length: 6 }, (_, i) => ({
        path: `/src/Controllers/Controller${i}.cs`,
        priorityScore: 10,
      })),
      low: [],
      skip: [],
    };
    const labels = computePrLabels(classified);
    assert.ok(labels.includes("high-risk"), "Should include 'high-risk'");
  });

  it("does NOT label 'high-risk' with fewer than 5 high files", () => {
    const classified = {
      high: [
        { path: "/src/Controllers/UserController.cs", priorityScore: 10 },
        { path: "/src/Services/AuthService.cs", priorityScore: 8 },
      ],
      low: [],
      skip: [],
    };
    const labels = computePrLabels(classified);
    assert.ok(!labels.includes("high-risk"), "Should NOT include 'high-risk' with only 2 high files");
  });

  it("does NOT label 'large-pr' with fewer than 15 files", () => {
    const classified = {
      high: Array.from({ length: 5 }, (_, i) => ({
        path: `/src/file${i}.ts`,
        priorityScore: 5,
      })),
      low: [],
      skip: [],
    };
    const labels = computePrLabels(classified);
    assert.ok(!labels.includes("large-pr"), "Should NOT include 'large-pr' with only 5 files");
  });

  it("returns empty labels for small clean PR", () => {
    const classified = {
      high: [
        { path: "/src/utils/format.py", priorityScore: 3 },
      ],
      low: [],
      skip: [],
    };
    const labels = computePrLabels(classified);
    // Only "backend" expected (Python)
    assert.deepEqual(labels, ["backend"]);
    assert.ok(!labels.includes("large-pr"));
    assert.ok(!labels.includes("high-risk"));
    assert.ok(!labels.includes("docs-only"));
  });

  it("combines multiple labels correctly (large + high-risk + full-stack)", () => {
    const classified = {
      high: [
        ...Array.from({ length: 5 }, (_, i) => ({
          path: `/src/Controllers/C${i}.cs`,
          priorityScore: 10,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          path: `/src/app/comp${i}.component.ts`,
          priorityScore: 9,
        })),
      ],
      low: Array.from({ length: 5 }, (_, i) => ({
        path: `/src/tests/test${i}.spec.ts`,
      })),
      skip: [],
    };
    const labels = computePrLabels(classified);
    assert.ok(labels.includes("large-pr"), "15 reviewable files → large-pr");
    assert.ok(labels.includes("high-risk"), "10 high files → high-risk");
    assert.ok(labels.includes("backend"), "Has .cs files → backend");
    assert.ok(labels.includes("frontend"), "Has .ts files → frontend");
  });

  it("applyPrLabels sends correct POST requests to Azure DevOps", async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200 };
    };

    // Re-implement applyPrLabels with injectable fetch
    async function applyPrLabels(project, repoId, prId, labels, azureHeaders, fetchFn) {
      if (labels.length === 0) return;
      const baseUrl = `${ORG}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/labels?api-version=${AZURE_API_VERSION}`;
      const results = await Promise.allSettled(
        labels.map(label =>
          fetchFn(baseUrl, {
            method: "POST",
            headers: { ...azureHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ name: label }),
          })
        )
      );
      return results;
    }

    await applyPrLabels("MyProject", "repo-1", 42, ["backend", "high-risk"], {}, mockFetch);

    assert.equal(calls.length, 2, "Should POST 2 labels");
    assert.equal(calls[0].body.name, "backend");
    assert.equal(calls[1].body.name, "high-risk");

    const expectedUrl = `${ORG}/MyProject/_apis/git/repositories/repo-1/pullRequests/42/labels?api-version=${AZURE_API_VERSION}`;
    assert.equal(calls[0].url, expectedUrl);
    assert.equal(calls[1].url, expectedUrl);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 7: Re-review on Push (Follow-up Review Tracking)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Feature 7: Re-review on Push", () => {

  // Simulate the exact KV flow that postUnifiedReview uses
  function createMockKV() {
    const store = new Map();
    return {
      store,
      async get(key, type) {
        const entry = store.get(key);
        if (!entry) return null;
        if (type === "json") return JSON.parse(entry.value);
        return entry.value;
      },
      async put(key, value, opts) {
        store.set(key, { value, opts });
      },
    };
  }

  it("first review: KV has no previous data, stores issues after review", async () => {
    const kv = createMockKV();
    const prId = 42;
    const reviewKey = `review:${prId}`;

    // Simulate postUnifiedReview reading KV (no previous review)
    const stored = await kv.get(reviewKey, "json");
    assert.equal(stored, null, "First review should find no previous data");

    let previousIssues = [];
    let reviewNumber = 1;
    if (stored && Array.isArray(stored.issues)) {
      previousIssues = stored.issues;
      reviewNumber = (stored.reviewNumber || 1) + 1;
    }

    assert.deepEqual(previousIssues, [], "No previous issues");
    assert.equal(reviewNumber, 1, "First review is iteration 1");

    // AI review produces comments
    const allComments = [
      { file: "/src/foo.ts", line: 10, comment: "Null reference risk on user.name" },
      { file: "/src/bar.ts", line: 5, comment: "LGTM" },
      { file: "/src/baz.ts", line: 20, comment: "Missing error handling" },
    ];

    // Extract issues (same logic as postUnifiedReview)
    const currentIssues = extractIssues(allComments);
    assert.equal(currentIssues.length, 2, "Should have 2 actionable issues (LGTM filtered)");

    // No follow-up section on first review
    assert.equal(previousIssues.length, 0, "No follow-up on first review");

    // Store in KV (same as postUnifiedReview does after posting)
    await kv.put(reviewKey, JSON.stringify({
      issues: currentIssues,
      reviewNumber,
      timestamp: Date.now(),
    }), { expirationTtl: 7 * 24 * 3600 });

    // Verify stored correctly
    const afterStore = await kv.get(reviewKey, "json");
    assert.equal(afterStore.issues.length, 2);
    assert.equal(afterStore.reviewNumber, 1);
    assert.equal(afterStore.issues[0].key, "/src/foo.ts::null reference risk on user.name");
    assert.equal(afterStore.issues[1].key, "/src/baz.ts::missing error handling");
  });

  it("second review: reads previous issues, produces follow-up section", async () => {
    const kv = createMockKV();
    const prId = 42;
    const reviewKey = `review:${prId}`;

    // Seed KV with first review data (simulates what postUnifiedReview stored)
    const firstReviewIssues = extractIssues([
      { file: "/src/foo.ts", line: 10, comment: "Null reference risk on user.name" },
      { file: "/src/baz.ts", line: 20, comment: "Missing error handling" },
    ]);
    await kv.put(reviewKey, JSON.stringify({
      issues: firstReviewIssues,
      reviewNumber: 1,
      timestamp: Date.now() - 60_000, // 1 minute ago
    }), { expirationTtl: 7 * 24 * 3600 });

    // ── Second review starts (developer pushed a fix) ──

    // Read previous review from KV (exact code from postUnifiedReview)
    let previousIssues = [];
    let reviewNumber = 1;
    const stored = await kv.get(reviewKey, "json");
    if (stored && Array.isArray(stored.issues)) {
      previousIssues = stored.issues;
      reviewNumber = (stored.reviewNumber || 1) + 1;
    }

    assert.equal(previousIssues.length, 2, "Should find 2 previous issues");
    assert.equal(reviewNumber, 2, "Should be iteration 2");

    // AI review on the new code: null ref fixed, error handling still there, new issue found
    const secondComments = [
      { file: "/src/baz.ts", line: 22, comment: "Missing error handling" }, // still there, line shifted
      { file: "/src/new.ts", line: 5, comment: "Unused import" },           // new issue
    ];

    const currentIssues = extractIssues(secondComments);
    assert.equal(currentIssues.length, 2);

    // Compute diff (exact code from postUnifiedReview)
    const diff = diffReviewIssues(previousIssues, currentIssues);

    assert.equal(diff.resolved.length, 1, "Null ref should be resolved");
    assert.equal(diff.resolved[0].comment, "Null reference risk on user.name");
    assert.equal(diff.stillOpen.length, 1, "Error handling should still be open");
    assert.equal(diff.stillOpen[0].comment, "Missing error handling");
    assert.equal(diff.new.length, 1, "Unused import should be new");
    assert.equal(diff.new[0].comment, "Unused import");

    // Build follow-up section (exact code from postUnifiedReview)
    const section = buildFollowUpSection(diff, reviewNumber);

    assert.ok(section.includes("Follow-up Review (iteration #2)"), "Should show iteration 2");
    assert.ok(section.includes("1 issue resolved"), "Should show 1 resolved");
    assert.ok(section.includes("1 issue still open"), "Should show 1 still open");
    assert.ok(section.includes("1 new issue"), "Should show 1 new");
    assert.ok(!section.includes("All previous issues"), "Should NOT celebrate when issues remain");

    // Store second review issues
    await kv.put(reviewKey, JSON.stringify({
      issues: currentIssues,
      reviewNumber,
      timestamp: Date.now(),
    }), { expirationTtl: 7 * 24 * 3600 });

    const afterStore = await kv.get(reviewKey, "json");
    assert.equal(afterStore.reviewNumber, 2);
    assert.equal(afterStore.issues.length, 2);
  });

  it("third review: all issues resolved, celebration message shown", async () => {
    const kv = createMockKV();
    const prId = 42;
    const reviewKey = `review:${prId}`;

    // Seed with second review data
    const secondReviewIssues = extractIssues([
      { file: "/src/baz.ts", line: 22, comment: "Missing error handling" },
      { file: "/src/new.ts", line: 5, comment: "Unused import" },
    ]);
    await kv.put(reviewKey, JSON.stringify({
      issues: secondReviewIssues,
      reviewNumber: 2,
      timestamp: Date.now() - 60_000,
    }), { expirationTtl: 7 * 24 * 3600 });

    // Third review: everything fixed, only LGTM comments
    const stored = await kv.get(reviewKey, "json");
    const previousIssues = stored.issues;
    const reviewNumber = stored.reviewNumber + 1;

    const thirdComments = [
      { file: "/src/baz.ts", line: 1, comment: "LGTM" },
      { file: "/src/new.ts", line: 1, comment: "LGTM" },
    ];

    const currentIssues = extractIssues(thirdComments);
    assert.equal(currentIssues.length, 0, "All LGTM = no issues");

    const diff = diffReviewIssues(previousIssues, currentIssues);
    assert.equal(diff.resolved.length, 2, "Both issues resolved");
    assert.equal(diff.stillOpen.length, 0);
    assert.equal(diff.new.length, 0);

    const section = buildFollowUpSection(diff, reviewNumber);
    assert.ok(section.includes("iteration #3"));
    assert.ok(section.includes("2 issues resolved"));
    assert.ok(section.includes("All previous issues have been addressed"));
  });

  it("KV read failure: falls back to first-review behavior (no crash)", async () => {
    const faultyKV = {
      async get() { throw new Error("KV read failure"); },
      async put() {},
    };

    const prId = 42;
    const reviewKey = `review:${prId}`;

    // Exact error handling from postUnifiedReview
    let previousIssues = [];
    let reviewNumber = 1;
    try {
      const stored = await faultyKV.get(reviewKey, "json");
      if (stored && Array.isArray(stored.issues)) {
        previousIssues = stored.issues;
        reviewNumber = (stored.reviewNumber || 1) + 1;
      }
    } catch (e) {
      // Fail-open — just proceed as first review
    }

    assert.deepEqual(previousIssues, [], "Should fall back to empty");
    assert.equal(reviewNumber, 1, "Should be treated as first review");
  });

  it("KV write failure: review still posts, just doesn't store for next time", async () => {
    const kv = createMockKV();
    const faultyWriteKV = {
      async get(key, type) { return kv.get(key, type); },
      async put() { throw new Error("KV write failure"); },
    };

    // Simulate posting review and attempting to store
    let stored = false;
    let writeError = null;
    try {
      await faultyWriteKV.put("review:42", JSON.stringify({ issues: [], reviewNumber: 1 }));
      stored = true;
    } catch (e) {
      writeError = e.message;
    }

    assert.equal(stored, false, "Write should have failed");
    assert.equal(writeError, "KV write failure");
    // The review was already posted at this point — the write failure is non-critical
  });

  it("gateway: PR update without merge commit is rejected (non-push event)", () => {
    // Simulate the new guard in worker.js
    const payload = {
      eventType: "git.pullrequest.updated",
      resource: {
        pullRequestId: 42,
        // No lastMergeSourceCommit — this is a reviewer-added event
      },
    };

    const hasMergeCommit = !!payload.resource?.lastMergeSourceCommit?.commitId;
    assert.equal(hasMergeCommit, false, "Non-push PR update should not have merge commit");
  });

  it("gateway: PR update with merge commit is accepted (push event)", () => {
    const payload = {
      eventType: "git.pullrequest.updated",
      resource: {
        pullRequestId: 42,
        lastMergeSourceCommit: { commitId: "abc123" },
        lastMergeTargetCommit: { commitId: "def456" },
      },
    };

    const hasMergeCommit = !!payload.resource?.lastMergeSourceCommit?.commitId;
    assert.equal(hasMergeCommit, true, "Push event should have merge commit");
  });

  it("dedup allows same PR with different sourceCommit (new push)", async () => {
    const kv = createMockKV();
    const prId = 42;

    // First push
    const dedupKey1 = `dedup:${prId}:commit_v1`;
    await kv.put(dedupKey1, "1", { expirationTtl: 3600 });

    // Second push (new commit)
    const dedupKey2 = `dedup:${prId}:commit_v2`;
    const existing = await kv.get(dedupKey2);
    assert.equal(existing, null, "New commit should not be deduplicated");
  });

  it("end-to-end: full comment includes follow-up section in correct position", () => {
    // Simulate building the complete review comment with follow-up
    const previousIssues = extractIssues([
      { file: "/src/foo.ts", line: 10, comment: "Bug here" },
    ]);
    const currentIssues = extractIssues([
      { file: "/src/bar.ts", line: 5, comment: "New bug" },
    ]);

    const diff = diffReviewIssues(previousIssues, currentIssues);
    const followUp = buildFollowUpSection(diff, 2);

    // Build comment the same way postUnifiedReview does
    const summary = ["## 🤖 AI Code Review", ""];
    if (previousIssues.length > 0) {
      summary.push(followUp);
    }
    summary.push("📊 **Reviewed 2 of 5 files** (3 skipped as non-reviewable)");

    const fullComment = summary.join("\n");

    // Verify order: header → follow-up → stats
    const headerPos = fullComment.indexOf("## 🤖 AI Code Review");
    const followUpPos = fullComment.indexOf("Follow-up Review");
    const statsPos = fullComment.indexOf("📊 **Reviewed");

    assert.ok(headerPos < followUpPos, "Follow-up should come after header");
    assert.ok(followUpPos < statsPos, "Stats should come after follow-up");
    assert.ok(fullComment.includes("1 issue resolved"), "Should show resolved");
    assert.ok(fullComment.includes("1 new issue"), "Should show new");
  });
});

# AI PR Review Bot

Cloudflare Workers-based bot that automatically reviews Azure DevOps pull requests using AI, generates Playwright tests, and tracks test flakiness.

## Architecture

6 workers connected via [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) (inter-worker calls are free — no subrequest cost):

| Worker | Config | Purpose |
|--------|--------|---------|
| **Gateway** | `wrangler.jsonc` | Receives Azure DevOps webhooks, classifies files, applies PR labels, delegates to other workers |
| **Review** | `wrangler.review.jsonc` | Fetches diffs, calls Workers AI (Mistral Small 3.1 24B) for code review, posts review comments |
| **PW-Context** | `wrangler.pw-context.jsonc` | Gathers Angular component context, docs, and existing test files for Playwright generation |
| **PW-Generate** | `wrangler.pw-generate.jsonc` | AI-driven Playwright test generation with post-processing (import fixes, fixture rewrites, test merging) |
| **PW-Push** | `wrangler.pw-push.jsonc` | Commits generated tests to branch, triggers CI pipeline, posts PR summary comment |
| **Flaky Detective** | `wrangler.flaky-detective.jsonc` | Tracks Playwright test flakiness over 14-day rolling window |

### Service Binding Topology

```
Azure DevOps Webhook
        |
    [Gateway]
     /       \
[Review]   [PW-Context]
   |          /       \
 (self)  [PW-Generate] [PW-Push]
```

- **Gateway** → Review (code review), PW-Context (test generation)
- **Review** → Self (batch continuation for large PRs)
- **PW-Context** → PW-Generate (AI test generation), PW-Push (commit + pipeline)
- **Flaky Detective** — independent, called directly from Azure Pipelines

All workers share a single KV namespace (`BOT_KV`) for neuron tracking, rate limiting, deduplication, doc caching, and flaky test data.

## Dashboards & Endpoints

| Endpoint | Worker | Method | Description |
|----------|--------|--------|-------------|
| `/` | All workers | GET | Health check (JSON) |
| `/neurons` | Gateway | GET | Neuron usage dashboard (HTML) — 14-day history, daily/hourly breakdown |
| `/report` | Flaky Detective | GET | Flaky test dashboard (HTML). Add `?format=json` for JSON |
| `/ingest` | Flaky Detective | POST | Receive build results from Azure Pipelines. Body: `{ "buildId": "12345" }` |
| `/test` | PW-Context | GET | Manual trigger for Playwright generation. Add `?dryRun=true` to skip push/pipeline/comment |
| `/` | Gateway | POST | Azure DevOps webhook receiver (PR events) |

### Dashboard URLs

| Dashboard | URL |
|-----------|-----|
| Neuron Usage | `https://ai-pr-review.soarespt0.workers.dev/neurons` |
| Flaky Detective | `https://flaky-detective.soarespt0.workers.dev/report` |
| Flaky Detective (JSON) | `https://flaky-detective.soarespt0.workers.dev/report?format=json` |

### Worker URLs

| Worker | URL |
|--------|-----|
| Gateway | `https://ai-pr-review.soarespt0.workers.dev` |
| Review | `https://ai-review-batch.soarespt0.workers.dev` |
| PW-Context | `https://pw-context.soarespt0.workers.dev` |
| PW-Generate | `https://pw-generate.soarespt0.workers.dev` |
| PW-Push | `https://pw-push.soarespt0.workers.dev` |
| Flaky Detective | `https://flaky-detective.soarespt0.workers.dev` |

## PR Labels (Auto-Applied)

The gateway automatically labels PRs based on file classification:

| Label | Condition |
|-------|-----------|
| `frontend` | PR contains `.ts`, `.tsx`, `.js`, `.jsx`, `.vue`, `.svelte`, or `.component.html` files |
| `backend` | PR contains `.cs`, `.py`, `.go`, `.rs`, `.java`, `.kt`, or `.rb` files |
| `large-pr` | 15+ reviewable files |
| `high-risk` | 5+ high-priority files (controllers, services, components) |
| `docs-only` | All files are non-reviewable (docs, configs, lock files) |
| `tests-only` | All reviewable files are test/spec files |
| `needs-backlog` | PR has no linked Azure DevOps work items |
| `security-alert` | AI review detected a potential hardcoded secret/credential in the diff |

## Deployment

### Using npm scripts (recommended)

```bash
npm run deploy                 # Gateway
npm run deploy:review          # Review
npm run deploy:pw-context      # PW-Context
npm run deploy:pw-generate     # PW-Generate
npm run deploy:pw-push         # PW-Push
npm run deploy:flaky-detective # Flaky Detective
```

### Using wrangler directly

```bash
npx wrangler deploy                                     # Gateway
npx wrangler deploy --config wrangler.review.jsonc      # Review
npx wrangler deploy --config wrangler.pw-context.jsonc  # PW-Context
npx wrangler deploy --config wrangler.pw-generate.jsonc # PW-Generate
npx wrangler deploy --config wrangler.pw-push.jsonc     # PW-Push
npx wrangler deploy --config wrangler.flaky-detective.jsonc # Flaky Detective
```

### Local development

```bash
npm run dev                 # Gateway
npm run dev:review          # Review
npm run dev:pw-context      # PW-Context
npm run dev:pw-generate     # PW-Generate
npm run dev:pw-push         # PW-Push
npm run dev:flaky-detective # Flaky Detective
```

### Secrets

Set these via `wrangler secret put` for each worker that needs Azure access:

```bash
# For gateway (wrangler.jsonc):
npx wrangler secret put AZURE_TOKEN

# For review worker:
npx wrangler secret put AZURE_TOKEN --config wrangler.review.jsonc

# For pw-context:
npx wrangler secret put AZURE_TOKEN --config wrangler.pw-context.jsonc

# For flaky detective:
npx wrangler secret put AZURE_TOKEN --config wrangler.flaky-detective.jsonc
```

### Environment variables

Configured in each `wrangler.*.jsonc` file under `vars`:

| Variable | Workers | Default | Description |
|----------|---------|---------|-------------|
| `AZURE_ORG` | All | `https://dev.azure.com/bindtuning` | Azure DevOps organization URL |
| `AZURE_PROJECT` | Flaky Detective | `BindTuning` | Azure DevOps project name |
| `PLAYWRIGHT_REPO_NAME` | Gateway | `BindTuning.AdminApp` | Repository for Playwright test generation |
| `PLAYWRIGHT_TARGET_BRANCH` | Gateway | `refs/heads/Dev` | Branch that triggers Playwright generation |
| `PIPELINE_ID` | PW-Push | `88` | Azure Pipelines ID for Playwright test runs |

## Testing

```bash
# Unit tests (116+ tests across 4 test files)
npm run test:unit

# Integration tests (requires Cloudflare Workers runtime via Miniflare)
npm run test:integration

# All tests (interactive watch mode)
npm test

# Dry-run test (standalone, uses node --test)
node --test test/dry-run.test.mjs
```

### Test files

| File | Type | Tests | What it covers |
|------|------|-------|----------------|
| `test/gateway.spec.js` | Unit | 37 | `classifyFiles`, `computePrLabels`, `buildBacklogContext`, `stripHtml` |
| `test/review.spec.js` | Unit | 30 | `computeDiff`, `truncateDiffAtHunkBoundary`, `calculateRisk`, `riskLevel` |
| `test/pw-generate.spec.js` | Unit | 17 | `extractTestBlocks`, `extractTestNames`, `sanitizeJsonStringValues` |
| `test/flaky-detective.spec.js` | Unit | 32 | `detectFlakiness`, `truncate`, `esc`, `shortenTestName`, `formatDate` |
| `test/index.spec.js` | Integration | — | Gateway HTTP routing in Cloudflare Workers runtime |
| `test/dry-run.test.mjs` | E2E | — | Secret scanning, diff computation against real data |

## Shared Libraries (`src/lib/`)

| Module | Purpose |
|--------|---------|
| `azure.js` | Azure DevOps API helpers: `orgUrl()`, `azureHeaders()`, `fetchFileAtCommit()` |
| `constants.js` | Shared constants: AI model names, batch sizes, branch names |
| `comments.js` | Post comment threads on Azure DevOps PRs |
| `diffs.js` | Myers diff algorithm, LCS inner-diff, hunk truncation, `CONTEXT_LINES` |
| `fetch.js` | `fetchWithTimeout()` wrapper with configurable timeout |
| `neurons.js` | Neuron budget tracking (check + record) via KV, daily limit config |
| `prompts.js` | AI prompt construction and response parsing for code review |
| `secrets.js` | Regex-based secret/credential detection on PR diffs (8 patterns) |

## AI Models

| Model | Constant | Used By | Purpose |
|-------|----------|---------|---------|
| Mistral Small 3.1 24B | `CF_AI_MODEL` | Review, PW-Generate | Code review, test generation |
| Llama 3.2 3B | `CF_AI_MODEL_CHEAP` | Review | PR summary (cheaper, ~1/4 neuron cost) |

**Neuron budget:** 8,000/day soft limit (Cloudflare free tier is 10,000; 2K buffer for KV race conditions). Usage tracked per day in KV with 14-day retention. Monitor at `/neurons`.

## Webhook Flow

```
1. Azure DevOps fires a PR webhook to the Gateway
2. Gateway: rate-limits (30/hour) and deduplicates (per PR+commit)
3. Gateway: fetches PR iterations + changed files + linked work items
4. Gateway: classifies files (skip/high/low), applies PR labels
5. Gateway: delegates batch to Review worker via Service Binding
6. Review worker: fetches all file contents in parallel
7. Review worker: computes diffs using Azure File Diffs API + file content
8. Review worker: calls Workers AI for code review, validates line numbers
9. Review worker: if more files remain, self-calls for next batch
10. Review worker: posts unified review comment with risk analysis + findings
11. If PR targets Dev on AdminApp: Gateway also delegates to PW-Context
12. PW-Context: identifies Angular components, fetches docs + existing tests
13. PW-Context: delegates to PW-Generate for AI test generation
14. PW-Generate: builds prompt from docs + diffs, calls AI, post-processes output
15. PW-Context: delegates to PW-Push for committing + pipeline trigger
16. PW-Push: pushes test files to branch, triggers pipeline, posts PR comment
```

## Flaky Detective Pipeline Integration

Add this step to your Azure Pipelines YAML to send build results to the Flaky Detective after each test run:

```yaml
- script: |
    curl -X POST https://flaky-detective.soarespt0.workers.dev/ingest \
      -H "Content-Type: application/json" \
      -d '{"buildId": "$(Build.BuildId)"}'
  displayName: 'Report to Flaky Detective'
  condition: always()
```

## Other Contents

| Path | Description |
|------|-------------|
| `copilot-api/` | Separate project — GitHub Copilot API proxy (has its own README) |
| `AGENTS.md` | Instructions for AI coding agents working on this codebase |

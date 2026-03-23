/**
 * Shared constants used across multiple workers.
 * Single source of truth — avoids drift when values change.
 */

// ─── AI Models ──────────────────────────────────────────────────────────────
export const CF_AI_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
export const CF_AI_MODEL_CHEAP = "@cf/meta/llama-3.2-3b-instruct";

// ─── Batching ───────────────────────────────────────────────────────────────
export const MAX_BATCH_FILES = 40;

// ─── Playwright Branch ──────────────────────────────────────────────────────
export const PLAYWRIGHT_TEST_BRANCH = "internship/playwright-unit-tests";

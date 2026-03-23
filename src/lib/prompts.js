/**
 * AI prompt construction and response parsing for PR review.
 *
 * Shared across:
 *  - review-worker.js  (builds prompts for AI code review)
 */

import { checkNeuronBudget, recordNeuronUsage, NEURON_DAILY_LIMIT } from "./neurons.js";
import { CF_AI_MODEL } from "./constants.js";

const MAX_DIFF_SIZE = 60000;

// ─── Build Diff Block ───────────────────────────────────────────────────────

/**
 * Concatenate file diffs into a single markdown-formatted block for AI input.
 * Stops adding files once the diff budget (MAX_DIFF_SIZE) is reached.
 * @param {Array<{path: string, diff: string, isAdd: boolean}>} fileChanges
 * @returns {string} Formatted diff block
 */
export function buildDiffBlock(fileChanges) {
  let diffBlock = "";
  for (const fc of fileChanges) {
    const header = `\n### FILE: ${fc.path} (${fc.isAdd ? "new file" : "edited"})`;
    const section = `${header}\n\`\`\`\n${fc.diff}\n\`\`\`\n`;
    if (diffBlock.length + section.length > MAX_DIFF_SIZE) {
      console.log("(log) [Review] Diff budget reached, skipping remaining files in this batch");
      break;
    }
    diffBlock += section;
  }
  return diffBlock;
}

// ─── AI Review Batch ────────────────────────────────────────────────────────

/**
 * Call Workers AI to review a batch of file changes.
 * Builds system + user prompts, calls the model, parses and validates the response.
 *
 * @param {Array<{path: string, diff: string, changedLines: number[], isAdd: boolean}>} fileChanges
 * @param {string} prTitle - PR title for context
 * @param {string} backlogContext - Linked work items context (may be empty)
 * @param {object} env - Cloudflare Workers env (AI binding, KV, etc.)
 * @returns {Promise<Array<{file: string, line: number, comment: string}>>} AI review comments
 */
export async function aiReviewBatch(fileChanges, prTitle, backlogContext, env) {
  const diffBlock = buildDiffBlock(fileChanges);
  const fileList = fileChanges.map((fc) => fc.path).join(", ");

  // Build an explicit list of changed lines per file for the AI
  const changedLinesSummary = fileChanges.map((fc) =>
    `${fc.path}: lines ${fc.changedLines.join(", ")}`
  ).join("\n");

  console.log(`(log) [Review] AI batch review: ${fileChanges.length} files, ${diffBlock.length} chars`);

  const systemPrompt = `You are a senior code reviewer. Review ONLY the changed lines in the PR diff below.
${backlogContext ? "\nYou will also receive linked product backlog items (user stories, tasks, bugs). Use them to:\n- Understand the INTENT behind the changes and validate the code aligns with the requirements.\n- Check if the code changes are actually RELEVANT to the linked work items. If the work item describes a completely different feature or task than what the code changes implement, flag this mismatch.\n" : ""}
OUTPUT FORMAT — respond with ONLY a raw JSON array, no markdown, no code fences:
[{"file":"/path/to/file.cs","line":42,"comment":"Your feedback"}]

RULES:
1. ONLY comment on lines prefixed with "+" (these are the changed/added lines)
2. NEVER comment on context lines (prefixed with a space) or removed lines (prefixed with "-")
3. "file" must exactly match the file path from the diff header
4. "line" must be the exact line number shown after the "+" prefix — ONLY use line numbers from the CHANGED LINES list below
5. NEVER repeat the same line number — one comment per line, max
6. Keep each comment concise (1-2 sentences)
7. Focus on: actual bugs, null reference risks, security vulnerabilities, clear logic errors
8. Do NOT guess or speculate — only flag issues you are certain about
9. Do NOT comment on code style, naming, or formatting
10. If the changed code looks correct, return: [{"file":"/path","line":1,"comment":"LGTM"}] where "line" is the first changed line number
11. Do NOT flag syntax errors like missing braces, unmatched if/else, or try/catch structure — the diff shows partial code and the IDE already catches these${backlogContext ? "\n12. If the code contradicts or clearly misses a requirement from the linked work items, flag it\n13. If the linked work items describe a DIFFERENT feature/task than what the code actually does, add a comment on the first changed line: \"⚠️ Backlog mismatch: the linked work item is about [X] but this code changes [Y]. Verify the correct work item is linked to this PR.\"" : ""}

IMPORTANT: The ONLY valid line numbers you may use in your response are listed below. Any other line number is WRONG:
${changedLinesSummary}`;

  const userPrompt = `PR: "${prTitle}"
Files changed: ${fileList}
${backlogContext}
${diffBlock}`;

  // Check neuron budget before calling AI
  const budget = await checkNeuronBudget(env, "Review");
  if (!budget.allowed) {
    console.log(`(log) [Review] Neuron budget exhausted (${budget.used}/${NEURON_DAILY_LIMIT}), skipping AI review`);
    return fileChanges.map(fc => ({
      file: fc.path,
      line: fc.changedLines?.[0] || 1,
      comment: "⚠️ AI review skipped — daily neuron budget exhausted. Manual review recommended.",
    }));
  }

  const aiResponse = await env.AI.run(CF_AI_MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 1024,
  });

  const rawResponse = aiResponse?.response;
  const rawReview = typeof rawResponse === "string"
    ? rawResponse
    : JSON.stringify(rawResponse, null, 2);
  console.log("(log) [Review] AI batch response:", rawReview?.substring(0, 200));

  // Record neuron usage
  const inputChars = systemPrompt.length + userPrompt.length;
  const outputChars = rawReview?.length || 0;
  await recordNeuronUsage(env, inputChars, outputChars, "Review");

  // Parse AI response into comments array
  try {
    let comments;
    if (Array.isArray(rawResponse)) {
      comments = rawResponse;
    } else if (typeof rawResponse === "string") {
      // Use greedy match to capture the entire JSON array (including nested arrays)
      const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
      comments = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } else {
      comments = [];
    }
    if (!Array.isArray(comments)) comments = [];
    // Deduplicate: keep only the first comment per file+line
    if (comments.length > 0) {
      const seen = new Set();
      comments = comments.filter((c) => {
        const key = `${c.file}:${c.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    // Validate: reject comments on lines that aren't actually changed
    const validLinesByFile = new Map();
    for (const fc of fileChanges) {
      validLinesByFile.set(fc.path, new Set(fc.changedLines));
    }
    const beforeCount = comments.length;
    comments = comments.filter((c) => {
      if (!c.file || !c.line) return false;
      const validLines = validLinesByFile.get(c.file);
      if (!validLines) {
        console.log(`(log) [Review] Rejected comment: file "${c.file}" not in batch`);
        return false;
      }
      const lineNum = parseInt(c.line, 10);
      if (!validLines.has(lineNum)) {
        console.log(`(log) [Review] Rejected comment: line ${lineNum} not a changed line in "${c.file}" (valid: ${[...validLines].slice(0, 5).join(",")}...)`);
        return false;
      }
      return true;
    });
    if (beforeCount !== comments.length) {
      console.log(`(log) [Review] Filtered ${beforeCount - comments.length} invalid comments (wrong line numbers)`);
    }
    return comments;
  } catch (e) {
    console.error("(log) [Review] AI JSON parse failed for batch:", e.message);
    return [];
  }
}

/**
 * Shared PR-comment helper used by pw-context and pw-push workers.
 */

import { orgUrl, AZURE_API_VERSION } from "./azure.js";
import { fetchWithRetry } from "./fetch.js";

/**
 * Post a comment thread on an Azure DevOps pull request.
 * Uses retry with backoff for transient Azure failures.
 * @param {object} env – Worker env bindings
 * @param {string} project
 * @param {string} repoId
 * @param {number} prId
 * @param {object} headers – Azure authorization headers
 * @param {string} content – Markdown content of the comment
 * @param {string} [tag=""] – Logging tag
 */
export async function postComment(env, project, repoId, prId, headers, content, tag = "") {
  const threadUrl = `${orgUrl(env)}/${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=${AZURE_API_VERSION}`;
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
    const res = await fetchWithRetry(threadUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: 10_000,
      retries: 3,
      tag,
    });

    if (res.ok) {
      console.log(`(log) [${tag}] Comment posted to PR`);
    } else {
      console.error(`(log) [${tag}] Comment post failed:`, res.status, await res.text());
    }
  } catch (e) {
    console.error(`(log) [${tag}] Comment post error:`, e.message);
  }
}

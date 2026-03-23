/**
 * Shared Azure DevOps helpers used across all workers.
 */

import { fetchWithRetry } from "./fetch.js";

export const AZURE_API_VERSION = "7.0";
export const AZURE_API_VERSION_FILEDIFFS = "7.1";

/**
 * Build Azure DevOps authorization headers from a PAT token.
 * @param {string} token – Azure DevOps PAT
 * @returns {{ Authorization: string }}
 */
export function azureHeaders(token) {
  return { Authorization: `Basic ${btoa(":" + token)}` };
}

/**
 * Build the base org URL.  Falls back to a default when env var is unset
 * (keeps backward-compat during migration to env vars).
 * @param {object} env – Worker env bindings
 * @returns {string}
 */
export function orgUrl(env) {
  return env?.AZURE_ORG || "https://dev.azure.com/bindtuning";
}

/**
 * Fetch a single file from a specific commit in an Azure DevOps repository.
 * Uses retry with backoff for transient Azure failures (429, 5xx).
 * @returns {Promise<string|null>} File content or null on failure.
 */
export async function fetchFileAtCommit(env, project, repoId, path, commitId, headers) {
  const url = `${orgUrl(env)}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(
    path
  )}&versionDescriptor.version=${commitId}&versionDescriptor.versionType=commit&includeContent=true&api-version=${AZURE_API_VERSION}`;
  try {
    const res = await fetchWithRetry(url, { headers, timeout: 10_000, retries: 3, tag: "Azure" });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

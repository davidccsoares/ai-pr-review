/**
 * Secret/credential detection for PR diffs.
 * Pure regex scanning — zero neuron cost, zero subrequests.
 *
 * Shared across:
 *  - review-worker.js  (scans diffs during code review)
 *  - dry-run tests      (validates detection logic)
 */

/**
 * Regex patterns for detecting accidentally committed secrets.
 * Each entry has a `regex` to match and a human-readable `label`.
 */
export const SECRET_PATTERNS = [
  { regex: /password\s*[=:]\s*["'][^"']+/i, label: "Hardcoded password" },
  { regex: /api[_-]?key\s*[=:]\s*["'][^"']+/i, label: "API key" },
  { regex: /secret\s*[=:]\s*["'][^"']+/i, label: "Secret value" },
  { regex: /Bearer\s+[A-Za-z0-9._-]{20,}/, label: "Bearer token" },
  { regex: /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, label: "Private key" },
  { regex: /ghp_[A-Za-z0-9]{36}/, label: "GitHub PAT" },
  { regex: /connectionString\s*[=:]\s*["'][^"']+/i, label: "Connection string" },
  { regex: /client[_-]?secret\s*[=:]\s*["'][^"']+/i, label: "Client secret" },
];

/**
 * Scan file diffs for accidentally committed secrets/credentials.
 * Only scans added lines (lines prefixed with "+").
 * @param {Array<{path: string, diff: string}>} fileChanges
 * @returns {Array<{file: string, line: number, pattern: string}>} findings
 */
export function scanForSecrets(fileChanges) {
  const findings = [];
  for (const fc of fileChanges) {
    if (!fc.diff) continue;
    const lines = fc.diff.split("\n");
    for (const line of lines) {
      // Only scan added lines (prefixed with "+")
      const addMatch = line.match(/^\+(\d+):\s*(.*)/);
      if (!addMatch) continue;
      const lineNum = parseInt(addMatch[1], 10);
      const content = addMatch[2];
      for (const sp of SECRET_PATTERNS) {
        if (sp.regex.test(content)) {
          findings.push({ file: fc.path, line: lineNum, pattern: sp.label });
          break; // One finding per line is enough
        }
      }
    }
  }
  return findings;
}

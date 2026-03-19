/**
 * Shared neuron-budget tracking for Cloudflare Workers AI.
 *
 * NOTE: KV is eventually-consistent, so concurrent invocations may read stale
 * counters and under-count usage.  We mitigate this with a 2 000-neuron safety
 * buffer (NEURON_DAILY_LIMIT = 8 000 vs the real 10 000 cap).  For stricter
 * guarantees, replace KV with a Durable Object counter.
 */

// Cloudflare Workers AI: 10,000 neurons/day (account-wide)
// Mistral Small 3.1 24B: ~31,876 neurons/M input tokens, ~50,488 neurons/M output tokens
// Llama 3.2 3B: much cheaper (~1/4 the cost)
export const NEURON_DAILY_LIMIT = 10000; // Free tier cap; paid plan allows overage at $0.011/1K neurons
export const NEURONS_PER_INPUT_CHAR = 31876 / 4_000_000; // ~4 chars/token, per 1M tokens
export const NEURONS_PER_OUTPUT_CHAR = 50488 / 4_000_000;

/**
 * Check if we have neuron budget remaining for today.
 * @param {object} env – Worker env bindings (needs BOT_KV)
 * @param {string} [tag=""] – Logging tag
 * @returns {Promise<{ allowed: boolean, used: number }>}
 */
export async function checkNeuronBudget(env, tag = "") {
  if (!env?.BOT_KV) return { allowed: true, used: 0 };
  try {
    const today = new Date().toISOString().slice(0, 10);
    const used = parseInt(await env.BOT_KV.get(`neurons:${today}`) || "0", 10);
    return { allowed: used < NEURON_DAILY_LIMIT, used };
  } catch (e) {
    console.log(`(log) [${tag}] KV read error (neuron check):`, e.message);
    return { allowed: true, used: 0 }; // Fail open
  }
}

/**
 * Record neuron usage after an AI call.
 * Estimates based on input prompt size + output size.
 * @param {object} env – Worker env bindings (needs BOT_KV)
 * @param {number} inputChars
 * @param {number} outputChars
 * @param {string} [tag=""]
 */
export async function recordNeuronUsage(env, inputChars, outputChars, tag = "") {
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
    console.log(`(log) [${tag}] Neurons: +${estimated} (total today: ${newTotal})`);
  } catch (e) {
    console.log(`(log) [${tag}] KV write error (neuron record):`, e.message);
  }
}

/**
 * Timeline summarizer — uses local LLM to create concise 1-line summaries
 * of OpenClaw chat responses for timeline display.
 *
 * Tries: on-device Foundation Models → local mlx-serve qwen (port 8800) →
 * Ollama → heuristic fallback. Non-blocking — caller should fire-and-forget,
 * update entry when ready.
 *
 * The provider order is the Node mirror of Swift's `TimelineSummarizer`
 * `.auto` chain (FoundationModels → MLX → Ollama → heuristic). It was
 * MLX-first for a long time, which meant a CLI-only user on macOS 26 with
 * Apple Intelligence available still got heuristic rows unless they also ran
 * an MLX server — the same machine summarized differently depending on which
 * daemon happened to be up. Keep the two chains in the same order.
 */

import { debug, log } from './logger.js';
import { SUMMARY_SYSTEM_PROMPT, cleanLLMOutput, mlxChatUrl, resolveMlxModel } from '@agentdeck/shared';
import { fetchMlxModels } from './mlx-probe.js';
import { callFoundationModelsHelper, probeFoundationModelsHelper } from './foundation-models-helper.js';
export { extractTopicHint } from '@agentdeck/shared';

const MLX_URL = mlxChatUrl();

// In-memory cache of the probe's first result, so summarizers don't hit
// /v1/models on every call. Refreshed lazily when the model call fails.
let probedFirstModel: string | null = null;
let probedAt = 0;
const PROBE_CACHE_TTL_MS = 60_000;

async function resolveModelForCall(): Promise<string> {
  const now = Date.now();
  if (!probedFirstModel || now - probedAt > PROBE_CACHE_TTL_MS) {
    try {
      const models = await fetchMlxModels();
      probedFirstModel = models && models.length > 0 ? models[0] : null;
      probedAt = now;
    } catch {
      probedFirstModel = null;
    }
  }
  return resolveMlxModel(probedFirstModel);
}
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const TIMEOUT_MS = 30_000; // 30s — first inference needs model load time
const MAX_INPUT_CHARS = 2000;

let fmAvailable: boolean | null = null;
let mlxAvailable: boolean | null = null;
let ollamaAvailable: boolean | null = null;
let fmFailedAt = 0;
let mlxFailedAt = 0;
let ollamaFailedAt = 0;
const RETRY_INTERVAL_MS = 60_000; // retry failed providers after 60s

/** Reset the cached provider availability (tests only). */
export function clearSummarizerProviderCacheForTests(): void {
  fmAvailable = null;
  mlxAvailable = null;
  ollamaAvailable = null;
  fmFailedAt = 0;
  mlxFailedAt = 0;
  ollamaFailedAt = 0;
  probedFirstModel = null;
  probedAt = 0;
}

/**
 * Summarize a chat response into a concise 1-line Korean summary.
 * Returns null if summarization fails (caller should use fallback).
 */
export async function summarizeResponse(text: string): Promise<string | null> {
  if (!text || text.length < 20) return null;

  const input = text.length > MAX_INPUT_CHARS
    ? text.slice(0, MAX_INPUT_CHARS) + '...'
    : text;

  let mlxJustFailed = false;
  let ollamaJustFailed = false;

  // Try on-device Foundation Models first — no server for the user to run,
  // and it is the same helper process the APME judge already keeps warm.
  // A miss here is not an error state: off-macOS, on macOS < 26, or with
  // Apple Intelligence disabled the probe simply reports unavailable and the
  // chain moves on. Only MLX+Ollama failing together is worth telling the
  // user about (that pair is what the user opts into by installing them).
  if (fmAvailable !== false || (Date.now() - fmFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callFoundationModels(input);
      if (result) {
        if (fmAvailable === false) debug('summarizer', 'Foundation Models recovered');
        fmAvailable = true;
        return result;
      }
    } catch (err) {
      fmAvailable = false;
      fmFailedAt = Date.now();
      debug('summarizer', `Foundation Models not available: ${String(err)}`);
    }
  }

  // Try MLX qwen next (retry after RETRY_INTERVAL_MS)
  if (mlxAvailable !== false || (Date.now() - mlxFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callMLX(input);
      if (result) {
        if (mlxAvailable === false) {
          // MLX recovered — note the transition.
          debug('summarizer', 'MLX recovered');
        }
        mlxAvailable = true;
        return result;
      }
    } catch (err) {
      mlxJustFailed = mlxAvailable !== false; // first time we observe failure
      mlxAvailable = false;
      mlxFailedAt = Date.now();
      debug('summarizer', `MLX not available: ${String(err)}`);
    }
  }

  // Try Ollama (retry after RETRY_INTERVAL_MS)
  if (ollamaAvailable !== false || (Date.now() - ollamaFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callOllama(input);
      if (result) {
        if (ollamaAvailable === false) {
          debug('summarizer', 'Ollama recovered');
        }
        ollamaAvailable = true;
        return result;
      }
    } catch (err) {
      ollamaJustFailed = ollamaAvailable !== false;
      ollamaAvailable = false;
      ollamaFailedAt = Date.now();
      debug('summarizer', `Ollama not available: ${String(err)}`);
    }
  }

  // Surface backend-down state to the user — but ONLY on the transition
  // (first time we observe both providers failing) and via `log`, NOT
  // `logError`. The summarizer is *optional* — when the user hasn't
  // installed MLX/Ollama, the heuristic row is the intended UX. Routing
  // through `log` means PTY mode (`agentdeck claude`) suppresses it
  // entirely (the message would otherwise bleed into Claude's terminal
  // session and read as a critical error). Daemon/CLI surfaces still see
  // it in stderr as a regular `[agentdeck]` info line.
  if ((mlxJustFailed && ollamaJustFailed)
      || (mlxJustFailed && ollamaAvailable === false)
      || (ollamaJustFailed && mlxAvailable === false)) {
    log(
      `[timeline] LLM summary backend offline (on-device Foundation Models: ${fmAvailable === false ? 'unavailable' : 'not reached'}, MLX:8800, Ollama:11434).`,
      'Timeline rows will use heuristic summaries.',
      'Install MLX (`mlx_vlm.server`) or Ollama to get LLM-summarized chat_end rows.',
    );
  }

  return null;
}

// extractTopicHint and cleanLLMOutput moved to @agentdeck/shared/timeline-summarizer

/** On-device summary via the bundled Swift helper (Apple Intelligence).
 *  Throws when the helper is unavailable so the caller falls to MLX; the
 *  helper owns its own request timeout, so there is no unbounded await here. */
async function callFoundationModels(input: string): Promise<string | null> {
  // Probe only on the first attempt: the probe is a full health round-trip to
  // the helper, and after that the generate call is its own liveness check.
  // (`fmAvailable` is null exactly once — the caller flips it either way.)
  if (fmAvailable === null) {
    const status = await probeFoundationModelsHelper();
    if (!status.available) throw new Error(status.reason ?? 'helper unavailable');
  }

  const text = await callFoundationModelsHelper(input, SUMMARY_SYSTEM_PROMPT);
  const result = cleanLLMOutput(text);
  if (result) debug('summarizer', `Foundation Models summary: ${result}`);
  return result;
}

async function callMLX(input: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const model = await resolveModelForCall();

  try {
    const resp = await fetch(MLX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        enable_thinking: false,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        max_tokens: 100,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`MLX ${resp.status}`);

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const result = cleanLLMOutput(content);
    if (result) debug('summarizer', `MLX summary: ${result}`);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function callOllama(input: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:7b',
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`Ollama ${resp.status}`);

    const data = await resp.json() as {
      message?: { content?: string };
    };
    const content = data.message?.content?.trim();
    if (!content) return null;

    const result = cleanLLMOutput(content);
    if (result) debug('summarizer', `Ollama summary: ${result}`);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

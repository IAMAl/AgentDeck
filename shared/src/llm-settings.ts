/**
 * MLX model pin loader — single source of truth for which MLX model
 * AgentDeck uses across probe, timeline summarizer, label summarizer,
 * and APME judge.
 *
 * Source: ~/.agentdeck/settings.json → `llm.mlx.{endpoint,model}`.
 * Falls back to legacy `apme.judge.{endpoint,model}` for backward compat.
 * Placeholder model ids ("qwen3-30b", "default", empty) are treated as unset.
 *
 * Mirrored in Swift by apple/AgentDeck/Daemon/Apme/ApmeSettings.swift
 * (LlmMlxConfig). Keep the two in sync when fields change.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Base URL used when settings.json pins no `llm.mlx.endpoint`. Exported so
 *  docs/config mirrors can be gated against it instead of restating it. */
export const DEFAULT_MLX_ENDPOINT = 'http://127.0.0.1:8800';
const DEFAULT_ENDPOINT = DEFAULT_MLX_ENDPOINT;

/** Final fallback when neither settings nor probe yield a model id. */
export const MLX_FALLBACK_MODEL = 'mlx-community/Qwen3-1.7B-4bit';

const PLACEHOLDER_MODEL_IDS = new Set(['', 'default', 'qwen3-30b']);

export interface MlxSettings {
  /** Base URL (no /chat/completions suffix). */
  endpoint: string;
  /** Pinned model id, or null when user hasn't chosen one. */
  model: string | null;
}

let cached: { at: number; value: MlxSettings } | null = null;
const CACHE_TTL_MS = 30_000;

function settingsPath(): string {
  const dir = process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
  return join(dir, 'settings.json');
}

function isPlaceholder(m: unknown): boolean {
  if (typeof m !== 'string') return true;
  return PLACEHOLDER_MODEL_IDS.has(m.trim());
}

function stripChatSuffix(url: string): string {
  return url
    .replace(/\/v1\/chat\/completions$/, '')
    .replace(/\/chat\/completions$/, '');
}

export function loadMlxSettings(): MlxSettings {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  let endpoint = DEFAULT_ENDPOINT;
  let model: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;

    const llmMlx = ((raw.llm as { mlx?: unknown } | undefined)?.mlx ?? {}) as {
      endpoint?: unknown; model?: unknown;
    };
    if (typeof llmMlx.endpoint === 'string' && llmMlx.endpoint.length > 0) {
      endpoint = stripChatSuffix(llmMlx.endpoint);
    }
    if (!isPlaceholder(llmMlx.model)) {
      model = (llmMlx.model as string).trim();
    }

    // Legacy fallback: apme.judge.{endpoint,model}
    if (model === null || endpoint === DEFAULT_ENDPOINT) {
      const judge = ((raw.apme as { judge?: unknown } | undefined)?.judge ?? {}) as {
        endpoint?: unknown; model?: unknown;
      };
      if (model === null && !isPlaceholder(judge.model)) {
        model = (judge.model as string).trim();
      }
      if (endpoint === DEFAULT_ENDPOINT && typeof judge.endpoint === 'string' && judge.endpoint.length > 0) {
        endpoint = stripChatSuffix(judge.endpoint);
      }
    }
  } catch {
    // file missing or malformed — keep defaults
  }
  const value: MlxSettings = { endpoint, model };
  cached = { at: Date.now(), value };
  return value;
}

/** Force a reload on next call — used by tests and after settings writes. */
export function clearMlxSettingsCache(): void {
  cached = null;
}

/**
 * Resolve the MLX model id for an actual inference call.
 * Priority: pinned settings → caller-supplied probe result → hardcoded fallback.
 */
export function resolveMlxModel(probeFirst?: string | null): string {
  const { model } = loadMlxSettings();
  if (model) return model;
  if (probeFirst && probeFirst.length > 0) return probeFirst;
  return MLX_FALLBACK_MODEL;
}

/**
 * Pick one model id from a live probe catalog. Returns `null` when the
 * server is unreachable or advertises no usable model — UI should render
 * "MLX · Not detected" rather than silently masquerading the fallback as
 * active (the fallback id won't exist on the user's disk and every
 * summarize call would fail).
 *
 * Priority — mirrors the 4-layer policy documented in CLAUDE.md:
 *   1. caller-supplied pin if present in catalog
 *   2. `MLX_FALLBACK_MODEL` if present in catalog — keeps the codebase's
 *      chosen lightweight default in sync with what the dashboard advertises
 *   3. first catalog entry (preserves the `auto-pick first` behavior added
 *      in commit 2b7b38b3 for the many-models case)
 *   4. null — no catalog
 */
export function pickMlxModel(
  catalog: string[] | null | undefined,
  pin?: string | null,
): string | null {
  if (!catalog || catalog.length === 0) return null;
  if (pin && pin.length > 0 && catalog.includes(pin)) return pin;
  if (catalog.includes(MLX_FALLBACK_MODEL)) return MLX_FALLBACK_MODEL;
  return catalog[0];
}

/**
 * Return a full chat-completions URL for the configured endpoint.
 * MLX-VLM uses `/chat/completions`; MLX-LM historically also answers on
 * `/v1/chat/completions`. We use the non-v1 path to match existing callers
 * (timeline-summarizer, label-summarizer, apme runner all hit /chat/completions).
 */
export function mlxChatUrl(): string {
  return `${loadMlxSettings().endpoint}/chat/completions`;
}

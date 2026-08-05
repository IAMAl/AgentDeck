/**
 * Model pricing table for APME cost tracking.
 *
 * Each `ModelEvent` in a SessionSample is priced at ingestion so cost is a
 * first-class, per-unit signal (not a post-hoc estimate). Local models (MLX,
 * on-device Foundation Models) are $0 — that is the whole point of the
 * local-first judge: guilt-free全数 evaluation.
 *
 * IMPORTANT — these rates are best-effort public list prices and are the ONE
 * place to correct pricing. They are intentionally overridable at runtime so a
 * code change is never required to fix a rate:
 *   - `setPricingOverrides({...})` merges a partial table (e.g. loaded from
 *     ~/.agentdeck/settings.json → apme.pricing) over the defaults.
 *   - Unknown models fall back to `UNKNOWN_PRICE` ($0) and are flagged via
 *     `isPricedModel()` so the dashboard can mark cost as "unpriced" rather
 *     than silently showing $0 as if the call were free.
 *
 * Rates are $/million-tokens (USD). Verified model IDs come from the Anthropic
 * `claude-api` reference; dollar figures should be confirmed against
 * https://anthropic.com/pricing before relying on absolute cost numbers.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inPerMtok: number;
  /** USD per 1M output tokens. */
  outPerMtok: number;
  /** Coarse provider tag for scorecard grouping / "subscription vs marginal". */
  provider?: string;
}

export const UNKNOWN_PRICE: ModelPrice = { inPerMtok: 0, outPerMtok: 0, provider: 'unknown' };
const ZERO_LOCAL: ModelPrice = { inPerMtok: 0, outPerMtok: 0, provider: 'local' };

/**
 * Default rates. Anthropic family rates use the long-standing public tier list
 * prices (Opus $15/$75, Sonnet $3/$15, Haiku $1/$5 per Mtok). Confirm/adjust
 * before treating absolute USD figures as authoritative — see file header.
 */
const DEFAULT_PRICING: Record<string, ModelPrice> = {
  // ── Anthropic ──
  'claude-fable-5': { inPerMtok: 20, outPerMtok: 100, provider: 'anthropic' },
  'claude-mythos-5': { inPerMtok: 20, outPerMtok: 100, provider: 'anthropic' },
  'claude-opus-4-8': { inPerMtok: 15, outPerMtok: 75, provider: 'anthropic' },
  'claude-opus-4-7': { inPerMtok: 15, outPerMtok: 75, provider: 'anthropic' },
  'claude-opus-4-6': { inPerMtok: 15, outPerMtok: 75, provider: 'anthropic' },
  'claude-sonnet-4-6': { inPerMtok: 3, outPerMtok: 15, provider: 'anthropic' },
  'claude-sonnet-4-5': { inPerMtok: 3, outPerMtok: 15, provider: 'anthropic' },
  'claude-haiku-4-5': { inPerMtok: 1, outPerMtok: 5, provider: 'anthropic' },
  // ── OpenAI (Codex) — confirm before trusting absolute USD ──
  'gpt-5-codex': { inPerMtok: 1.25, outPerMtok: 10, provider: 'openai' },
  'gpt-5': { inPerMtok: 1.25, outPerMtok: 10, provider: 'openai' },
};

let overrides: Record<string, ModelPrice> = {};

/** Merge a partial pricing table over the defaults (e.g. from user settings). */
export function setPricingOverrides(table: Record<string, ModelPrice> | null | undefined): void {
  overrides = table ? { ...table } : {};
}

/** Normalize a raw model id to its pricing key. Strips provider prefixes and
 *  date suffixes so "anthropic/claude-opus-4-8-20260101" → "claude-opus-4-8". */
export function normalizeModelId(model: string): string {
  let m = model.trim().toLowerCase();
  // provider prefix: "anthropic/claude-…", "openai/gpt-…", "openrouter:…"
  // Local ids keep their org segment — "mlx-community/qwen3…" is not the same
  // thing as a hosted "qwen3…", and isLocalModel() keys off the whole string.
  const slash = m.lastIndexOf('/');
  if (slash >= 0 && !isLocalModel(m)) m = m.slice(slash + 1);
  // date suffix: "-20260101" or "-2026-01-01"
  m = m.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return m;
}

/** Prefixes that mark a model id as running on this machine.
 *  `foundationmodels:` matters because that is the exact shape this codebase
 *  emits: `effectiveJudgeModelTag()` returns `foundationModels:apple-intelligence`
 *  (and `ApmeJudgeFoundationModels.judgeModelLabel` mirrors it byte-for-byte).
 *  Matching only the bare word left that tag priced as "unknown" — which reads
 *  as *unpriced*, not free, everywhere `isPricedModel()` gates a cost display. */
const LOCAL_PREFIXES = [
  'mlx:', 'local:', 'ollama:', 'lmstudio:',
  'foundationmodels:', 'foundation-models:', 'apple-fm:',
  // Hugging Face orgs whose ids arrive verbatim from a local server's
  // /v1/models — e.g. "mlx-community/Qwen3.6-35B-A3B-4bit", which is what an
  // MLX server actually advertises and what resolveMlxModel() hands back.
  'mlx-community/', 'lmstudio-community/',
];

/** Local models (MLX, Foundation Models, Ollama, any explicit local: prefix). */
export function isLocalModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (LOCAL_PREFIXES.some((p) => m.startsWith(p))) return true;
  return m === 'foundationmodels' || m === 'foundation-models' || m === 'apple-fm';
}

/** Look up the price record for a model (override → default → local → unknown). */
export function priceFor(model: string | null | undefined): ModelPrice {
  if (!model) return UNKNOWN_PRICE;
  if (isLocalModel(model)) return ZERO_LOCAL;
  const key = normalizeModelId(model);
  return overrides[key] ?? overrides[model] ?? DEFAULT_PRICING[key] ?? DEFAULT_PRICING[model] ?? UNKNOWN_PRICE;
}

/** True when we have a real (non-$0-fallback) rate or a known-free local model. */
export function isPricedModel(model: string | null | undefined): boolean {
  if (!model) return false;
  if (isLocalModel(model)) return true; // known $0, not "missing"
  const key = normalizeModelId(model);
  return Boolean(overrides[key] ?? overrides[model] ?? DEFAULT_PRICING[key] ?? DEFAULT_PRICING[model]);
}

export function providerFor(model: string | null | undefined): string {
  return priceFor(model).provider ?? 'unknown';
}

/** Compute USD cost for a single model call. Rounds to 6 dp (≈$0.000001). */
export function priceUsd(model: string | null | undefined, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  const usd = (inputTokens / 1_000_000) * p.inPerMtok + (outputTokens / 1_000_000) * p.outPerMtok;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

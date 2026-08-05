/**
 * Pricing predicate tests.
 *
 * The rule this file guards: a model id this codebase *itself produces* for a
 * local engine must price as $0 with provider "local" — not as "unknown".
 * The difference is user-visible: `isPricedModel()` is what a surface asks
 * before deciding between showing "$0.00" and showing "unpriced", so an
 * unrecognized local tag reads as missing data rather than as a free call.
 *
 * The two shapes that were missed:
 *   - `foundationModels:apple-intelligence` — emitted by
 *     `effectiveJudgeModelTag()` in bridge/src/apme/runner.ts and mirrored in
 *     Swift's `ApmeJudgeFoundationModels.judgeModelLabel`.
 *   - `mlx-community/Qwen3.6-35B-A3B-4bit` — the id an MLX server advertises
 *     on /v1/models, handed straight back by `resolveMlxModel()`.
 */

import { describe, it, expect } from 'vitest';
import { isLocalModel, isPricedModel, priceUsd, providerFor, normalizeModelId } from '../pricing.js';

describe('isLocalModel', () => {
  it('accepts the judge tag the runner emits for Foundation Models', () => {
    expect(isLocalModel('foundationModels:apple-intelligence')).toBe(true);
    expect(isLocalModel('foundation-models:apple-intelligence')).toBe(true);
    expect(isLocalModel('apple-fm:default')).toBe(true);
  });

  it('accepts the bare Foundation Models spellings', () => {
    expect(isLocalModel('foundationModels')).toBe(true);
    expect(isLocalModel('foundation-models')).toBe(true);
    expect(isLocalModel('apple-fm')).toBe(true);
  });

  it('accepts raw ids as a local server advertises them', () => {
    expect(isLocalModel('mlx-community/Qwen3.6-35B-A3B-4bit')).toBe(true);
    expect(isLocalModel('mlx-community/Qwen3-1.7B-4bit')).toBe(true);
    expect(isLocalModel('lmstudio-community/gemma-3-12b')).toBe(true);
  });

  it('accepts the explicit local prefixes', () => {
    expect(isLocalModel('mlx:qwen3-30b')).toBe(true);
    expect(isLocalModel('ollama:qwen2.5:7b')).toBe(true);
    expect(isLocalModel('lmstudio:gemma-3-12b')).toBe(true);
    expect(isLocalModel('local:whatever')).toBe(true);
  });

  it('does not claim hosted models are local', () => {
    expect(isLocalModel('claude-opus-4-8')).toBe(false);
    expect(isLocalModel('anthropic/claude-opus-4-8')).toBe(false);
    expect(isLocalModel('gpt-5-codex')).toBe(false);
    // "openai:<model>" is the generic OpenAI-compatible adapter, which is just
    // as likely to be OpenRouter as a loopback server — never assume local.
    expect(isLocalModel('openai:gpt-5')).toBe(false);
  });
});

describe('local models cost nothing and say so', () => {
  it('prices local judge tags at $0', () => {
    expect(priceUsd('foundationModels:apple-intelligence', 500_000, 200_000)).toBe(0);
    expect(priceUsd('mlx-community/Qwen3.6-35B-A3B-4bit', 1_000_000, 1_000_000)).toBe(0);
  });

  it('reports them as priced, not as unpriced', () => {
    expect(isPricedModel('foundationModels:apple-intelligence')).toBe(true);
    expect(isPricedModel('mlx-community/Qwen3.6-35B-A3B-4bit')).toBe(true);
    // A genuinely unknown hosted model stays unpriced so a surface can say so.
    expect(isPricedModel('some-vendor-model-we-never-heard-of')).toBe(false);
  });

  it('groups them under the local provider', () => {
    expect(providerFor('foundationModels:apple-intelligence')).toBe('local');
    expect(providerFor('mlx-community/Qwen3.6-35B-A3B-4bit')).toBe('local');
    expect(providerFor('claude-opus-4-8')).toBe('anthropic');
  });
});

describe('normalizeModelId', () => {
  it('strips hosted provider prefixes', () => {
    expect(normalizeModelId('anthropic/claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeModelId('claude-opus-4-8-20260101')).toBe('claude-opus-4-8');
  });

  it('keeps the org segment of a local id', () => {
    expect(normalizeModelId('mlx-community/Qwen3-1.7B-4bit')).toBe('mlx-community/qwen3-1.7b-4bit');
  });

  it('still prices a hosted model after normalization', () => {
    expect(priceUsd('anthropic/claude-opus-4-8', 1_000_000, 0)).toBeGreaterThan(0);
  });
});

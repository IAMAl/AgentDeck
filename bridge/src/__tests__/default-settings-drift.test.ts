/**
 * Drift gate for `config/default-settings.json`.
 *
 * That file is documentation, not input: no code copies or reads it, so for
 * years it could disagree with the real defaults and nothing failed. It did —
 * it shipped `judge.backend: "mlx"` while the code defaulted to
 * `foundationModels`, plus a `whisperModel` key left over from the removed
 * whisper.cpp path and an `autoTune` key no loader has ever read.
 *
 * This test makes the file honest in both directions:
 *   1. every value must equal the built-in default the loader applies, and
 *   2. every key must be one a loader actually reads.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_MLX_ENDPOINT } from '@agentdeck/shared';
import { DEFAULT_APME_CONFIG } from '../apme/settings.js';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const settingsPath = join(repoRoot, 'config', 'default-settings.json');

function loadFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
}

describe('config/default-settings.json', () => {
  it('parses as an object', () => {
    const json = loadFile();
    expect(typeof json).toBe('object');
  });

  it('carries only keys a loader actually reads', () => {
    const json = loadFile();
    // `_comment` documents the file itself; the rest must be live settings.
    const allowed = new Set(['_comment', 'llm', 'apme']);
    const unread = Object.keys(json).filter((k) => !allowed.has(k));
    expect(unread, `unread keys in default-settings.json: ${unread.join(', ')}`).toEqual([]);
  });

  it('states the MLX defaults that shared/src/llm-settings.ts applies', () => {
    const mlx = (loadFile().llm as { mlx?: Record<string, unknown> } | undefined)?.mlx ?? {};
    expect(mlx.endpoint).toBe(DEFAULT_MLX_ENDPOINT);
    // `null` is the "no pin — take the server's pick" default, not a model id.
    expect(mlx.model).toBeNull();
  });

  it('states the APME defaults that loadApmeConfig() applies', () => {
    const apme = loadFile().apme as Record<string, unknown>;
    expect(apme.enabled).toBe(DEFAULT_APME_CONFIG.enabled);
    expect(apme.deterministic).toEqual(DEFAULT_APME_CONFIG.deterministic);
    expect(apme.availableModels).toEqual(DEFAULT_APME_CONFIG.availableModels);
    expect(apme.judge).toEqual(DEFAULT_APME_CONFIG.judge);
  });

  it('does not resurrect the removed whisper / autoTune keys', () => {
    const raw = readFileSync(settingsPath, 'utf-8');
    const apme = loadFile().apme as Record<string, unknown>;
    expect(raw).not.toContain('"whisperModel"');
    expect(apme.autoTune).toBeUndefined();
  });
});

/**
 * Node summarizer provider chain.
 *
 * The regression this guards: the Node chain used to start at MLX, while the
 * Swift daemon's `TimelineSummarizer` started at on-device Foundation Models.
 * On the same Mac, the same response summarized differently depending on which
 * daemon was up — and a CLI-only user with Apple Intelligence available but no
 * MLX server got heuristic rows for no reason.
 *
 * Order under test (mirror of Swift `.auto`): FM → MLX → Ollama → null
 * (null = caller falls back to the heuristic).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fm = vi.hoisted(() => ({
  probe: vi.fn(async (): Promise<{ available: boolean; reason?: string }> => ({ available: true })),
  call: vi.fn(async (): Promise<string> => 'on-device summary'),
}));

vi.mock('../foundation-models-helper.js', () => ({
  probeFoundationModelsHelper: fm.probe,
  callFoundationModelsHelper: fm.call,
}));

const { summarizeResponse, clearSummarizerProviderCacheForTests } = await import('../timeline-summarizer.js');

const RESPONSE = 'Fixed the daemon reconnect loop and added a regression test for the backoff ladder.';

/** Minimal OpenAI/Ollama-shaped chat responses keyed by URL. */
function stubHttp(routes: Record<string, unknown | null>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : null;
    if (body == null) throw new Error(`connection refused: ${url}`);
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }));
}

const MLX_REPLY = { choices: [{ message: { content: 'mlx summary' } }] };
const OLLAMA_REPLY = { message: { content: 'ollama summary' } };

beforeEach(() => {
  clearSummarizerProviderCacheForTests();
  fm.probe.mockReset();
  fm.call.mockReset();
  fm.probe.mockResolvedValue({ available: true });
  fm.call.mockResolvedValue('on-device summary');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('summarizeResponse provider chain', () => {
  it('prefers on-device Foundation Models over MLX', async () => {
    stubHttp({ '8800': MLX_REPLY, '11434': OLLAMA_REPLY });

    const out = await summarizeResponse(RESPONSE);

    expect(out).toBe('on-device summary');
    expect(fm.call).toHaveBeenCalledTimes(1);
    // MLX must not even be probed when the on-device model answered.
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.map((c) => String(c[0])).filter((u) => u.includes('8800'))).toEqual([]);
  });

  it('falls to MLX when the helper is unavailable', async () => {
    fm.probe.mockResolvedValue({ available: false, reason: 'macOS < 26' });
    stubHttp({ '8800': MLX_REPLY, '11434': OLLAMA_REPLY });

    expect(await summarizeResponse(RESPONSE)).toBe('mlx summary');
  });

  it('falls to Ollama when the helper and MLX are both down', async () => {
    fm.probe.mockResolvedValue({ available: false, reason: 'not installed' });
    stubHttp({ '11434': OLLAMA_REPLY });

    expect(await summarizeResponse(RESPONSE)).toBe('ollama summary');
  });

  it('returns null when every provider is down so the caller uses the heuristic', async () => {
    fm.probe.mockResolvedValue({ available: false, reason: 'not installed' });
    stubHttp({});

    expect(await summarizeResponse(RESPONSE)).toBeNull();
  });

  it('probes the helper once, not once per summary', async () => {
    stubHttp({ '8800': MLX_REPLY });

    await summarizeResponse(RESPONSE);
    await summarizeResponse(`${RESPONSE} And a second one, distinctly worded.`);

    expect(fm.probe).toHaveBeenCalledTimes(1);
    expect(fm.call).toHaveBeenCalledTimes(2);
  });
});

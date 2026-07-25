import { describe, it, expect } from 'vitest';
import { resolveSessionIdPrefix } from '../session-id-resolve.js';

const OBSERVED = 'observed:claude:0303f8a9-f727-4633-8e7d-4ccc71fe6be0';
const OBSERVED2 = 'observed:claude:caa8a89d-3be9-4d7e-a193-c38639d6d96a';
const ROSTER = [OBSERVED, OBSERVED2, 'openclaw-gateway', 'claude-9121'];

describe('resolveSessionIdPrefix', () => {
  it('returns exact matches untouched', () => {
    expect(resolveSessionIdPrefix('openclaw-gateway', ROSTER)).toBe('openclaw-gateway');
    expect(resolveSessionIdPrefix(OBSERVED, ROSTER)).toBe(OBSERVED);
  });

  it('restores the ESP32 31-char truncation of an observed id', () => {
    // prepareForSerial caps id to 31 chars — the exact shape a board echoes back
    const truncated = OBSERVED.slice(0, 31);
    expect(truncated.length).toBe(31);
    expect(resolveSessionIdPrefix(truncated, ROSTER)).toBe(OBSERVED);
  });

  it('leaves ambiguous prefixes unresolved', () => {
    // "observed:claude:" prefixes BOTH observed sessions — must not guess
    expect(resolveSessionIdPrefix('observed:claude:', ROSTER)).toBe('observed:claude:');
  });

  it('leaves unknown ids and empty input untouched', () => {
    expect(resolveSessionIdPrefix('nope', ROSTER)).toBe('nope');
    expect(resolveSessionIdPrefix('', ROSTER)).toBe('');
  });
});

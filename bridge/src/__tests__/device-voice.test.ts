import { describe, it, expect } from 'vitest';
import { DeviceVoiceCollector, buildWav } from '../device-voice.js';
import { readFileSync } from 'fs';

const CONN = Symbol('conn');
const OTHER = Symbol('other');

describe('buildWav', () => {
  it('wraps PCM in a canonical 16-bit mono header', () => {
    const pcm = Buffer.alloc(320); // 10ms @16k
    const wav = buildWav(pcm, 16000);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);        // mono
    expect(wav.readUInt32LE(24)).toBe(16000);    // sample rate
    expect(wav.readUInt16LE(34)).toBe(16);       // bits
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.length).toBe(44 + pcm.length);
  });
});

describe('DeviceVoiceCollector', () => {
  it('assembles frames into a WAV and reports the target session', () => {
    const c = new DeviceVoiceCollector();
    c.begin(CONN, { sampleRate: 16000, sessionId: 'observed:claude:abc', board: 't_embed' });
    c.append(CONN, Buffer.alloc(200, 1));
    c.append(CONN, Buffer.alloc(120, 2));
    const out = c.end(CONN, { durationMs: 250 });
    expect(out).not.toBeNull();
    expect(out!.sessionId).toBe('observed:claude:abc');
    const wav = readFileSync(out!.wavPath);
    expect(wav.readUInt32LE(40)).toBe(320);
    out!.cleanup();
  });

  it('ignores binary frames with no open utterance', () => {
    const c = new DeviceVoiceCollector();
    expect(c.append(CONN, Buffer.alloc(64))).toBe(false);
  });

  it('keeps utterances separate per connection', () => {
    const c = new DeviceVoiceCollector();
    c.begin(CONN, { sessionId: 'a' });
    c.begin(OTHER, { sessionId: 'b' });
    c.append(CONN, Buffer.alloc(100));
    expect(c.openCount).toBe(2);
    expect(c.end(OTHER, {})).toBeNull();      // nothing captured on OTHER
    expect(c.end(CONN, {})!.sessionId).toBe('a');
  });

  it('returns null for a cancelled or empty utterance', () => {
    const c = new DeviceVoiceCollector();
    c.begin(CONN, {});
    c.append(CONN, Buffer.alloc(64));
    expect(c.end(CONN, { cancel: true })).toBeNull();
    c.begin(CONN, {});
    expect(c.end(CONN, {})).toBeNull();
  });

  it('caps a runaway utterance instead of buffering without bound', () => {
    const c = new DeviceVoiceCollector();
    c.begin(CONN, { sampleRate: 16000 });
    const oneSecond = Buffer.alloc(32000);
    for (let i = 0; i < 40; i++) c.append(CONN, oneSecond); // 40s > 30s cap
    const out = c.end(CONN, {})!;
    const wav = readFileSync(out.wavPath);
    expect(wav.readUInt32LE(40)).toBeLessThanOrEqual(16000 * 2 * 30);
    out.cleanup();
  });

  it('abandons and sweeps stale utterances', () => {
    const c = new DeviceVoiceCollector();
    c.begin(CONN, {});
    c.abandon(CONN);
    expect(c.openCount).toBe(0);
    c.begin(OTHER, {});
    c.sweep(Date.now() + 120_000);
    expect(c.openCount).toBe(0);
  });
});

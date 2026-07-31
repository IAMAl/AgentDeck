import { describe, it, expect } from 'vitest';
import { DeviceVoiceCollector, buildWav, normalizePcm, dropSilentInterleave } from '../device-voice.js';
import { readFileSync } from 'fs';

describe('dropSilentInterleave', () => {
  const pcmOf = (samples: number[]): Buffer => {
    const b = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => b.writeInt16LE(v, i * 2));
    return b;
  };
  const many = (pairs: Array<[number, number]>): number[] => pairs.flatMap(([a, b]) => [a, b]);

  it('drops a digitally silent odd slot (ips10 duplex shape)', () => {
    const src = many(Array.from({ length: 32 }, (_, i) => [100 + i, 0] as [number, number]));
    const out = dropSilentInterleave(pcmOf(src));
    expect(out.length).toBe(32 * 2);
    expect(out.readInt16LE(0)).toBe(100);
    expect(out.readInt16LE(2)).toBe(101);
  });

  it('drops a digitally silent even slot (flipped alignment)', () => {
    const src = many(Array.from({ length: 32 }, (_, i) => [0, 200 + i] as [number, number]));
    const out = dropSilentInterleave(pcmOf(src));
    expect(out.length).toBe(32 * 2);
    expect(out.readInt16LE(0)).toBe(200);
  });

  it('passes true mono audio through untouched', () => {
    const src = Array.from({ length: 64 }, (_, i) => (i % 3) * 500 - 300);
    const pcm = pcmOf(src);
    expect(dropSilentInterleave(pcm)).toBe(pcm);
  });

  it('still collapses when the stuffed slot carries rare glitch spikes', () => {
    // Measured shape (2026-07-31): 0.2% of the silent slot's samples were
    // glitches, one at near full scale — a peak-based detector declined and
    // the zero-stuffed audio went to the recognizer as "no speech".
    const src = many(Array.from({ length: 200 }, (_, i) =>
      [300 + i, i === 77 ? 26000 : 0] as [number, number]));
    const out = dropSilentInterleave(pcmOf(src));
    expect(out.length).toBe(200 * 2);
    expect(out.readInt16LE(0)).toBe(300);
  });

  it('passes silence and tiny buffers through untouched', () => {
    const silent = pcmOf(new Array(64).fill(0));
    expect(dropSilentInterleave(silent)).toBe(silent);
    const tiny = pcmOf([5, 0, 6, 0]);
    expect(dropSilentInterleave(tiny)).toBe(tiny);
  });
});

describe('normalizePcm', () => {
  const pcmOf = (samples: number[]): Buffer => {
    const b = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => b.writeInt16LE(v, i * 2));
    return b;
  };

  it('boosts a quiet capture toward the target peak', () => {
    // The measured ips10 shape: speech peaking ~2500/32768 was rejected by
    // the recognizer outright ("No speech detected").
    const out = normalizePcm(pcmOf([2500, -1250, 0, 100]));
    expect(out.readInt16LE(0)).toBe(26000);
    expect(out.readInt16LE(2)).toBe(-13000);
    expect(out.readInt16LE(4)).toBe(0);
  });

  it('caps the gain so near-silence does not become full-scale noise', () => {
    const out = normalizePcm(pcmOf([10, -10]));
    expect(out.readInt16LE(0)).toBe(160); // x16 cap, not x2600
  });

  it('leaves already-loud audio untouched', () => {
    const pcm = pcmOf([30000, -30000]);
    expect(normalizePcm(pcm)).toBe(pcm);
  });

  it('leaves pure silence untouched', () => {
    const pcm = pcmOf([0, 0, 0]);
    expect(normalizePcm(pcm)).toBe(pcm);
  });

  it('clamps instead of wrapping at the int16 edge', () => {
    const out = normalizePcm(pcmOf([25999, -32768, 4]));
    for (let i = 0; i + 1 < out.length; i += 2) {
      const v = out.readInt16LE(i);
      expect(v).toBeGreaterThanOrEqual(-32768);
      expect(v).toBeLessThanOrEqual(32767);
    }
  });
});

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

  it('reports device-side and in-flight PCM loss before transcription', () => {
    const c = new DeviceVoiceCollector();
    c.begin(CONN, { sampleRate: 16000 });
    c.append(CONN, Buffer.alloc(2048));
    const overflow = c.end(CONN, {
      capturedBytes: 4096,
      queuedBytes: 2048,
      droppedFrames: 2,
    })!;
    expect(overflow.integrityError).toContain('audio_transport_overflow');
    overflow.cleanup();

    c.begin(CONN, { sampleRate: 16000 });
    c.append(CONN, Buffer.alloc(1024));
    const incomplete = c.end(CONN, {
      capturedBytes: 2048,
      queuedBytes: 2048,
      droppedFrames: 0,
    })!;
    expect(incomplete.integrityError).toBe(
      'audio_transport_incomplete: received 1024/2048 bytes',
    );
    incomplete.cleanup();
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

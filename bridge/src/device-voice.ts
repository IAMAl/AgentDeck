/**
 * Device-sourced voice: a board streams PCM16 while its push-to-talk key is
 * held, and the daemon turns that into a prompt for the session the board was
 * pointing at.
 *
 * Wire shape (per WS connection):
 *   {"type":"voice_begin","sampleRate":16000,"format":"pcm16","sessionId":…}
 *   <binary frames: raw little-endian PCM16 mono>
 *   {"type":"voice_end","durationMs":…,"cancel":false}
 *
 * Binary frames carry no envelope, so they are attributed to whichever socket
 * has an open utterance — hence the per-connection state here.
 *
 * The board contributes a microphone and a button; transcription is Apple's
 * on-device recognizer through the bundled Swift helper (same engine as the
 * Swift daemon — see docs/voice-setup.md).
 */

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { debug } from './logger.js';

/** Refuse to buffer more than ~30s of 16 kHz mono PCM16 from one utterance. */
const MAX_UTTERANCE_BYTES = 16000 * 2 * 30;
/** An utterance whose voice_end never arrives (board reboot, WiFi drop). */
const UTTERANCE_TTL_MS = 60_000;

export interface VoiceUtterance {
  sampleRate: number;
  sessionId: string;
  board: string;
  chunks: Buffer[];
  bytes: number;
  startedAt: number;
  truncated: boolean;
}

export interface VoiceCaptureResult {
  sessionId: string;
  board: string;
  wavPath: string;
  durationMs: number;
  integrityError?: string;
  cleanup: () => void;
}

/**
 * Collapse a stereo-framed capture whose second slot is empty. The ips10's
 * full-duplex I2S RX delivers L/R sample pairs with the ES8311's data in one
 * slot and digital silence in the other, while the firmware labels the stream
 * 16 kHz mono — so real 6.5 s of speech arrived as 13 s of half-speed audio
 * with a zero stuffed between every sample, which the recognizer rejects as
 * "No speech detected" (measured 2026-07-31: odd-stream RMS exactly 0, and a
 * 7.9 kHz mirror image in the spectrum — the classic zero-stuffing artifact).
 * Phase-agnostic: whichever stream is digitally silent is dropped, so a
 * boot-time slot-alignment flip cannot break it. A true mono capture (both
 * streams carry signal — e.g. the T-Embed's PDM mic) passes through untouched.
 */
export function dropSilentInterleave(pcm: Buffer): Buffer {
  const n = Math.floor(pcm.length / 2);
  if (n < 32) return pcm;
  // Near-zero FRACTION per stream, not peak: the stuffed slot carries rare
  // glitch spikes (measured 2026-07-31: 0.2% of odd samples nonzero with one
  // spike at full scale), so a single glitch must not veto the collapse — nor
  // become the normalization reference, which is why this runs before
  // normalizePcm. Real audio is nowhere near 95% flat: even quiet room tone
  // dithers above ±2 on most samples.
  let evenZeros = 0;
  let oddZeros = 0;
  const half = Math.floor(n / 2);
  for (let i = 0; i < n; i++) {
    const v = Math.abs(pcm.readInt16LE(i * 2));
    if (v <= 2) {
      if (i % 2 === 0) evenZeros++;
      else oddZeros++;
    }
  }
  const evenFlat = evenZeros >= half * 0.95;
  const oddFlat = oddZeros >= half * 0.95;
  let keepPhase: number;
  if (oddFlat && !evenFlat) keepPhase = 0;
  else if (evenFlat && !oddFlat) keepPhase = 1;
  else return pcm;
  const out = Buffer.alloc(Math.floor(n / 2) * 2 + (n % 2 === 1 && keepPhase === 0 ? 2 : 0));
  let o = 0;
  for (let i = keepPhase; i < n; i += 2) {
    out.writeInt16LE(pcm.readInt16LE(i * 2), o);
    o += 2;
  }
  debug('voice', `dropped silent interleave slot (kept phase ${keepPhase}, ${n} -> ${o / 2} samples)`);
  return out.subarray(0, o);
}

/**
 * Boost quiet captures before transcription. The ips10's ES8311 electret path
 * delivers real speech at only ~8% FS peak even with the PGA at +36 dB, and
 * Apple's recognizer rejects that level outright ("No speech detected",
 * kAFAssistantErrorDomain 1110 — measured 2026-07-31 on a 13 s utterance with
 * clearly audible speech at RMS ~400/32768). Scaling toward a healthy peak is
 * loss-free for the recognizer's purposes and a no-op for captures that are
 * already loud. Peak-based with a gain cap: RMS would over-amplify a mostly
 * silent capture, and the cap keeps a near-silent buffer from becoming noise.
 */
export function normalizePcm(pcm: Buffer, targetPeak = 26000, maxGain = 16): Buffer {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  if (peak === 0 || peak >= targetPeak) return pcm;
  const gain = Math.min(maxGain, targetPeak / peak);
  if (gain <= 1.01) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    let v = Math.round(pcm.readInt16LE(i) * gain);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    out.writeInt16LE(v, i);
  }
  debug('voice', `normalized: peak ${peak} -> x${gain.toFixed(1)}`);
  return out;
}

/** Build a canonical 16-bit PCM WAV around raw little-endian samples. */
export function buildWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM chunk size
  header.writeUInt16LE(1, 20);           // format = PCM
  header.writeUInt16LE(1, 22);           // channels = mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Per-connection utterance assembly. One instance per daemon; connections are
 * keyed by whatever opaque handle the server uses for a socket.
 */
export class DeviceVoiceCollector {
  private open = new Map<unknown, VoiceUtterance>();

  begin(conn: unknown, msg: Record<string, unknown>): void {
    const sampleRate = typeof msg.sampleRate === 'number' && msg.sampleRate > 0
      ? msg.sampleRate : 16000;
    this.open.set(conn, {
      sampleRate,
      sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : '',
      board: typeof msg.board === 'string' ? msg.board : 'esp32',
      chunks: [],
      bytes: 0,
      startedAt: Date.now(),
      truncated: false,
    });
    debug('voice', `utterance begin (${sampleRate} Hz, session ${String(msg.sessionId ?? '').slice(0, 20)})`);
  }

  /** Returns false when no utterance is open — the caller should ignore the frame. */
  append(conn: unknown, data: Buffer): boolean {
    const u = this.open.get(conn);
    if (!u) return false;
    if (u.bytes + data.length > MAX_UTTERANCE_BYTES) {
      // Keep the head rather than the tail: the command is at the start, and
      // dropping silently would look like a mis-transcription.
      u.truncated = true;
      return true;
    }
    u.chunks.push(Buffer.from(data));
    u.bytes += data.length;
    return true;
  }

  /**
   * Finish the utterance. Returns null when it was cancelled, empty, or when
   * nothing was open. The caller owns `cleanup()` once transcription is done.
   */
  end(conn: unknown, msg: Record<string, unknown>): VoiceCaptureResult | null {
    const u = this.open.get(conn);
    this.open.delete(conn);
    if (!u) return null;
    if (msg.cancel === true) {
      debug('voice', 'utterance cancelled by device');
      return null;
    }
    if (u.bytes === 0) {
      debug('voice', 'utterance empty — nothing captured');
      return null;
    }
    const pcm = normalizePcm(dropSilentInterleave(Buffer.concat(u.chunks)));
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-voice-'));
    const wavPath = join(dir, 'utterance.wav');
    writeFileSync(wavPath, buildWav(pcm, u.sampleRate));
    const durationMs = typeof msg.durationMs === 'number'
      ? msg.durationMs
      : Math.round((u.bytes / 2 / u.sampleRate) * 1000);
    const capturedBytes = typeof msg.capturedBytes === 'number' && msg.capturedBytes >= 0
      ? msg.capturedBytes : undefined;
    const queuedBytes = typeof msg.queuedBytes === 'number' && msg.queuedBytes >= 0
      ? msg.queuedBytes : undefined;
    const droppedFrames = typeof msg.droppedFrames === 'number' && msg.droppedFrames >= 0
      ? msg.droppedFrames : 0;
    let integrityError: string | undefined;
    if (droppedFrames > 0) {
      integrityError = `audio_transport_overflow: ${droppedFrames} frame(s) dropped on device`
        + ` (${queuedBytes ?? u.bytes}/${capturedBytes ?? 'unknown'} bytes queued)`;
    } else if (capturedBytes !== undefined && u.bytes !== capturedBytes) {
      integrityError = `audio_transport_incomplete: received ${u.bytes}/${capturedBytes} bytes`;
    }
    debug('voice', `utterance end: ${u.bytes} bytes, ${durationMs}ms${u.truncated ? ' (truncated)' : ''}`);
    return {
      sessionId: u.sessionId,
      board: u.board,
      wavPath,
      durationMs,
      ...(integrityError ? { integrityError } : {}),
      cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
    };
  }

  /**
   * A whole utterance that arrived as one HTTP POST body (`POST /esp32/voice`)
   * rather than as a streamed WS/serial capture. TCP already guaranteed
   * ordering and completeness, so there is no integrity accounting — the body
   * either arrived or the request failed.
   */
  saveDirect(pcm: Buffer, meta: {
    board?: string; sessionId?: string; sampleRate?: number; durationMs?: number;
  }): VoiceCaptureResult {
    const sampleRate = typeof meta.sampleRate === 'number' && meta.sampleRate > 0
      ? meta.sampleRate : 16000;
    pcm = normalizePcm(dropSilentInterleave(pcm));
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-voice-'));
    const wavPath = join(dir, 'utterance.wav');
    writeFileSync(wavPath, buildWav(pcm, sampleRate));
    const durationMs = typeof meta.durationMs === 'number' && meta.durationMs > 0
      ? meta.durationMs
      : Math.round((pcm.length / 2 / sampleRate) * 1000);
    debug('voice', `direct utterance: ${pcm.length} bytes, ${durationMs}ms (${meta.board ?? 'esp32'})`);
    return {
      sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : '',
      board: typeof meta.board === 'string' && meta.board ? meta.board : 'esp32',
      wavPath,
      durationMs,
      cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
    };
  }

  /** Drop an utterance whose socket died mid-stream. */
  abandon(conn: unknown): void {
    if (this.open.delete(conn)) debug('voice', 'utterance abandoned (socket closed)');
  }

  /** Reap utterances whose voice_end never arrived. */
  sweep(now = Date.now()): void {
    for (const [conn, u] of this.open) {
      if (now - u.startedAt > UTTERANCE_TTL_MS) {
        this.open.delete(conn);
        debug('voice', 'utterance expired without voice_end');
      }
    }
  }

  get openCount(): number {
    return this.open.size;
  }
}

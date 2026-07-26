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
  cleanup: () => void;
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
    const pcm = Buffer.concat(u.chunks);
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-voice-'));
    const wavPath = join(dir, 'utterance.wav');
    writeFileSync(wavPath, buildWav(pcm, u.sampleRate));
    const durationMs = typeof msg.durationMs === 'number'
      ? msg.durationMs
      : Math.round((u.bytes / 2 / u.sampleRate) * 1000);
    debug('voice', `utterance end: ${u.bytes} bytes, ${durationMs}ms${u.truncated ? ' (truncated)' : ''}`);
    return {
      sessionId: u.sessionId,
      board: u.board,
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

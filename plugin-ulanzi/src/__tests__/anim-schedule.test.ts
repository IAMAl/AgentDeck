import { describe, it, expect } from 'vitest';
import { SESSION_SLOT_ANIM_CYCLE, renderSessionSlot } from '@agentdeck/shared';
import type { SessionInfo } from '@agentdeck/shared';
import {
  ANIM_FRAMES,
  ANIM_STEP,
  ANIM_DELAY_MS,
  ANIM_PROBE_FRAME,
  animFrameAt,
  frameOrderFor,
  phaseOffsetFor,
} from '../anim-schedule.js';

/** Dash travel per animFrame unit — the fastest thing on a tile. */
const ORBIT_SPEED_PX = 22;

describe('D200H animation schedule', () => {
  it('spans exactly one animation cycle', () => {
    // The whole point: Studio loops the GIF, so frame ANIM_FRAMES must land back
    // where frame 0 started. Allowing more than half a pixel of accumulated dash
    // drift would let a rounding change reintroduce a visible jump on wrap.
    const driftPx = Math.abs(animFrameAt(ANIM_FRAMES) - SESSION_SLOT_ANIM_CYCLE) * ORBIT_SPEED_PX;
    expect(driftPx).toBeLessThan(0.5);
  });

  it('steps evenly and monotonically through the cycle', () => {
    const frames = Array.from({ length: ANIM_FRAMES }, (_, i) => animFrameAt(i));
    expect(frames[0]).toBe(0);
    expect(new Set(frames).size).toBe(ANIM_FRAMES);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i] - frames[i - 1]).toBeCloseTo(ANIM_STEP, 6);
    }
  });

  it('keeps the dash step small enough to read as motion, not as a jump', () => {
    // Above roughly a fifth of the dash period the orbit stops reading as travel
    // and starts to strobe; this is the constraint that bounds ANIM_FRAMES.
    const BORDER_PERIMETER = 512;
    expect((ANIM_STEP * ORBIT_SPEED_PX) / BORDER_PERIMETER).toBeLessThan(0.2);
  });

  it('paces the loop at the Stream Deck tick so both surfaces share a tempo', () => {
    const loopMs = ANIM_FRAMES * ANIM_DELAY_MS;
    expect(loopMs).toBeGreaterThan(SESSION_SLOT_ANIM_CYCLE * 150 * 0.95);
    expect(loopMs).toBeLessThan(SESSION_SLOT_ANIM_CYCLE * 150 * 1.05);
  });

  it('gives each key its own phase without breaking the loop', () => {
    const KEYS = ['0_0', '1_0', '2_0', '3_0', '4_0', '0_1', '1_1', '2_1', '3_1', '4_1', '0_2', '1_2', '2_2'];
    for (const key of KEYS) {
      const offset = phaseOffsetFor(key);
      expect(Number.isInteger(offset)).toBe(true);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(ANIM_FRAMES);
      // A rotated sequence must still visit every frame exactly once, or the
      // shifted loop would repeat or skip frames and stop being seamless.
      const rotated = Array.from({ length: ANIM_FRAMES }, (_, i) => (i + offset) % ANIM_FRAMES);
      expect(new Set(rotated).size).toBe(ANIM_FRAMES);
    }
  });

  it('is deterministic per key so a tile keeps encoding to the same bytes', () => {
    expect(phaseOffsetFor('2_1')).toBe(phaseOffsetFor('2_1'));
  });

  it('identifies a rotated loop by its OWN first frame, not by deck 0', () => {
    // Reproduces the encoder's identity check on stand-in frames. Reading the
    // unrotated deck 0 makes every phase-shifted key compare as stale forever, so
    // its encode is cancelled and requeued in a loop and no GIF is ever produced
    // — a failure that leaves the tiles looking merely un-animated.
    const decks = Array.from({ length: ANIM_FRAMES }, (_, i) => `frame-${i}`);
    const shifted = ['1_0', '2_0', '3_0'].filter((k) => phaseOffsetFor(k) !== 0);
    expect(shifted.length).toBeGreaterThan(0);
    for (const key of shifted) {
      const order = frameOrderFor(key);
      const frames = order.map((f) => decks[f]);
      const cacheKey = frames[0];
      expect(decks[order[0]]).toBe(cacheKey);   // the check the encoder makes
      expect(decks[0]).not.toBe(cacheKey);       // the one that used to be made
    }
  });

  it('starts each key at the frame its phase offset names', () => {
    for (const key of ['0_0', '1_0', '2_0', '4_1', '2_2']) {
      expect(frameOrderFor(key)[0]).toBe(phaseOffsetFor(key));
      expect(frameOrderFor(key)).toHaveLength(ANIM_FRAMES);
      expect(new Set(frameOrderFor(key)).size).toBe(ANIM_FRAMES);
    }
  });

  it('separates neighbouring keys by a visible fraction of the cycle', () => {
    // Side-by-side and stacked keys are the pairs a user reads as "in sync", so
    // they are the ones that must not land a frame or two apart.
    const neighbours: [string, string][] = [['0_0', '1_0'], ['1_0', '2_0'], ['0_0', '0_1'], ['3_1', '4_1']];
    for (const [a, b] of neighbours) {
      const gap = Math.abs(phaseOffsetFor(a) - phaseOffsetFor(b));
      const wrapped = Math.min(gap, ANIM_FRAMES - gap);
      expect(wrapped / ANIM_FRAMES).toBeGreaterThan(0.15);
    }
  });

  it('spreads a full deck across the cycle instead of clustering', () => {
    const KEYS = ['0_0', '1_0', '2_0', '3_0', '4_0', '0_1', '1_1', '2_1', '3_1', '4_1', '0_2', '1_2', '2_2'];
    expect(new Set(KEYS.map(phaseOffsetFor)).size).toBe(KEYS.length);
  });

  it('probes a frame that a moving tile cannot match by accident', () => {
    const session = { id: 's', agentType: 'claude-code', state: 'processing', projectName: 'P' } as unknown as SessionInfo;
    const base = renderSessionSlot(session, false, 0, undefined, { animated: true });
    const probe = renderSessionSlot(session, false, ANIM_PROBE_FRAME, undefined, { animated: true });
    expect(probe).not.toBe(base);

    // …and a genuinely static tile must still compare equal, or every idle key
    // would be encoded as a pointless 24-frame loop.
    const idle = { ...session, state: 'idle' } as SessionInfo;
    expect(renderSessionSlot(idle, false, ANIM_PROBE_FRAME, undefined, { animated: true }))
      .toBe(renderSessionSlot(idle, false, 0, undefined, { animated: true }));
  });
});

/**
 * Guards the two properties a pre-baked animation loop depends on. Surfaces that
 * tick live (Stream Deck) tolerate both being wrong; the D200H bakes a GIF and
 * cannot, so neither failure shows up anywhere these tests don't look.
 */
import { describe, it, expect } from 'vitest';
import {
  renderSessionSlot,
  renderQuietSlot,
  renderEmptySlot,
  SESSION_SLOT_ANIM_CYCLE,
} from '../svg-renderers/session-slot-renderer.js';
import type { SessionInfo } from '../protocol.js';

const session = (state: string): SessionInfo =>
  ({ id: 's1', agentType: 'claude-code', state, projectName: 'AgentDeck' } as unknown as SessionInfo);

const frame = (state: string, animFrame: number, isActive = false): string =>
  renderSessionSlot(session(state), isActive, animFrame, undefined, { animated: true });

/** Every dash phase in the tile, in source order. */
const dashOffsets = (svg: string): number[] =>
  [...svg.matchAll(/stroke-dashoffset="(-?[\d.]+)"/g)].map((m) => Number(m[1]));

/** Every opacity in the tile, in source order. */
const opacities = (svg: string): number[] =>
  [...svg.matchAll(/opacity="([\d.]+)"/g)].map((m) => Number(m[1]));

const STATES = ['processing', 'awaiting_permission', 'idle'] as const;

describe('session slot animation cycle', () => {
  // A GIF loop spans exactly one cycle. If any animated value fails to return to
  // its frame-0 value, the loop jumps on wrap — which is what a hand-picked frame
  // count and two incommensurate orbit speeds used to produce.
  for (const state of STATES) {
    for (const isActive of [false, true]) {
      it(`returns to its starting phase after one cycle (${state}, active=${isActive})`, () => {
        const start = frame(state, 0, isActive);
        const wrapped = frame(state, SESSION_SLOT_ANIM_CYCLE, isActive);

        const a = dashOffsets(start);
        const b = dashOffsets(wrapped);
        expect(b).toHaveLength(a.length);
        // Dash phase repeats with the border period, so equality is modulo it;
        // compare the raw offsets, which the renderer already reduces.
        a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 6));

        const oa = opacities(start);
        const ob = opacities(wrapped);
        expect(ob).toHaveLength(oa.length);
        oa.forEach((v, i) => expect(ob[i]).toBeCloseTo(v, 6));
      });
    }
  }

  // The processing border's phase anchor used to default to `animFrame`, which
  // cancels the rotation exactly (offset = -(animFrame*speed - animFrame*speed)),
  // so every caller that does not track a per-session start frame — the D200H
  // plugin among them — rendered a frozen dash and never knew.
  it('animates the processing border without an explicit start frame', () => {
    const offsets = [0, 1, 2, 3].map((f) => dashOffsets(frame('processing', f))[0]);
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  it('keeps a supplied start frame as a phase offset, not a freeze', () => {
    const withAnchor = [0, 1, 2, 3].map(
      (f) => dashOffsets(renderSessionSlot(session('processing'), false, f, undefined, {
        animated: true,
        processingStartFrame: 7,
      }))[0],
    );
    expect(new Set(withAnchor).size).toBe(withAnchor.length);
    // A different anchor must move the same motion to a different phase, so
    // sibling tiles that started at different times do not orbit in lockstep.
    expect(withAnchor[0]).not.toBeCloseTo(dashOffsets(frame('processing', 0))[0], 6);
  });

  it('leaves an unfocused idle tile static — it must not be encoded as a loop', () => {
    const a = frame('idle', 0);
    const b = frame('idle', SESSION_SLOT_ANIM_CYCLE / 2);
    expect(b).toBe(a);
  });
});

describe('tile identity is byte-stable', () => {
  // Consumers treat a tile's SVG as its identity: the D200H plugin dedups device
  // pushes on it, decides whether the tile animates by comparing two frames of
  // it, and caches the encoded GIF under it. A renderer that emits a random id
  // therefore breaks all three at once while looking perfectly correct on screen
  // — which is exactly what `svgFrame` did with `Math.random()`.
  it('renders the same quiet slot identically every time', () => {
    const renders = Array.from({ length: 5 }, () => renderQuietSlot());
    expect(new Set(renders).size).toBe(1);
  });

  it('renders the same empty slot identically every time', () => {
    const renders = Array.from({ length: 5 }, () => renderEmptySlot());
    expect(new Set(renders).size).toBe(1);
  });

  it('emits no random-looking ids from any session-slot renderer', () => {
    const svgs = [
      renderQuietSlot(),
      renderEmptySlot(),
      ...STATES.flatMap((s) => [frame(s, 0), frame(s, 0, true)]),
    ];
    // Two runs of the whole set must agree element-for-element.
    const again = [
      renderQuietSlot(),
      renderEmptySlot(),
      ...STATES.flatMap((s) => [frame(s, 0), frame(s, 0, true)]),
    ];
    expect(again).toEqual(svgs);
  });
});

/**
 * The frame schedule for a baked D200H animation loop.
 *
 * Kept separate from `app.ts` (a side-effectful entry module) so the one property
 * that matters here is testable: the sampled frames must span exactly one
 * `SESSION_SLOT_ANIM_CYCLE`. Ulanzi Studio loops the GIF natively, so a schedule
 * covering any other span leaves every orbiting dash mid-travel at the wrap and
 * the tile visibly jumps — the failure a live ticker like the Stream Deck can
 * never have, and therefore the one nobody notices until it ships.
 */
import { SESSION_SLOT_ANIM_CYCLE } from '@agentdeck/shared';

/**
 * Frames per loop. The Stream Deck advances one animFrame unit per 150ms, so 24
 * frames put the D200H at the same ~145ms cadence rather than an arbitrary one.
 * Raising this costs payload and encode time roughly linearly; lowering it makes
 * the orbiting dash step visibly.
 */
export const ANIM_FRAMES = 24;

/** Stream Deck tick length, in ms per animFrame unit — the tempo to match. */
const SD_MS_PER_ANIM_UNIT = 150;

/**
 * animFrame advance per GIF frame. Rounded so the value does not drag a float
 * tail into the SVG filter ids (which embed animFrame) and therefore into the
 * cache keys; the rounding error is checked to stay sub-pixel.
 */
export const ANIM_STEP = +(SESSION_SLOT_ANIM_CYCLE / ANIM_FRAMES).toFixed(3);

/** Per-frame delay written into the GIF. */
export const ANIM_DELAY_MS = Math.round((SESSION_SLOT_ANIM_CYCLE * SD_MS_PER_ANIM_UNIT) / ANIM_FRAMES);

/**
 * Half a cycle from frame 0 — the most different an animated tile can look, so
 * the "does this key animate?" probe never misreads a small step as static.
 */
export const ANIM_PROBE_FRAME = +(SESSION_SLOT_ANIM_CYCLE / 2).toFixed(3);

/** animFrame value for the i-th frame of the loop. */
export function animFrameAt(i: number): number {
  return +(i * ANIM_STEP).toFixed(3);
}

/**
 * Keys per D200H row — the device is 5 + 5 + 3, so `col_row` maps to a spatial
 * index with a stride of 5.
 */
const KEYS_PER_ROW = 5;

/**
 * Step between neighbouring keys' phases, in frames. Coprime with ANIM_FRAMES so
 * successive keys walk the whole cycle without repeating, and large enough that
 * physically adjacent keys land far apart (7/24 ≈ 105° of the loop) rather than a
 * frame or two apart, which would still read as synchronised.
 */
const PHASE_STRIDE = 7;

/**
 * Where in the cycle a given key's loop begins.
 *
 * Every tile is periodic over one cycle, so starting a key's frame sequence at a
 * different point is a pure phase shift — the loop stays seamless and, because
 * the frames are an evenly spaced sample of that cycle, the shift is just a
 * ROTATION of the already-rendered frame decks. Per-key timing therefore costs no
 * extra rendering at all.
 *
 * Keyed on the position rather than on the session so a tile's GIF is stable:
 * the same appearance on the same key always encodes to the same bytes and keeps
 * hitting the cache. (The Stream Deck reaches the same "don't move in lockstep"
 * goal from the other side, via `processingStartFrame` — it has no baked loop to
 * keep byte-stable.)
 */
export function phaseOffsetFor(key: string): number {
  const [col, row] = key.split('_').map(Number);
  const index = Number.isFinite(col) && Number.isFinite(row) ? row * KEYS_PER_ROW + col : 0;
  return (index * PHASE_STRIDE) % ANIM_FRAMES;
}

/**
 * Which rendered frame this key plays at each step of its loop, in order.
 *
 * The single definition of the rotation. Callers need it twice — once to collect
 * the frames to encode, and once to ask "is the tile I am encoding still the
 * current one?" — and deriving those two independently is a real trap: comparing
 * a rotated tile against the UNROTATED frame 0 makes every phase-shifted key look
 * permanently stale, so its encode is cancelled and requeued forever and no GIF
 * is ever produced. Read `frameOrderFor(key)[0]` for a key's identity frame.
 */
export function frameOrderFor(key: string): number[] {
  const offset = phaseOffsetFor(key);
  return Array.from({ length: ANIM_FRAMES }, (_, i) => (i + offset) % ANIM_FRAMES);
}

/**
 * Build a looping animated GIF from rasterized SVG frames for `setGifDataIcon`.
 *
 * Ulanzi Studio plays the GIF natively and loops it, so we push ONE GIF per state
 * transition (no per-frame ticking like the Stream Deck plugin needs). Transparency
 * is preserved (rgba4444) so the tile's rounded corners stay see-through.
 *
 * Two properties make this affordable on a link that the D200H LCD struggles to
 * keep up with:
 *
 *  • DELTA FRAMES. Between two adjacent frames only the orbiting border moves —
 *    measured at ~8% of the pixels. Every pixel identical to the previous frame is
 *    written as the transparent index with GIF disposal method 1 ("leave in
 *    place"), so the decoder keeps the pixel already on screen. Long runs of one
 *    index are exactly what LZW collapses, which cut a 14-frame tile from 71 KB to
 *    22 KB with no visual change. This is only sound because the tile's opaque
 *    silhouette never changes across a loop — delta frames can add ink but cannot
 *    erase it back to transparent, so a shrinking shape would smear.
 *  • ONE GLOBAL PALETTE. Quantizing per frame both costs time and forces a local
 *    color table into every frame. We quantize once over all frames (so a color
 *    that only appears at the pulse's peak still gets an entry) and pass the
 *    palette on the first frame only.
 *
 * Encoding yields to the event loop between frames: it runs on the same thread
 * that services Ulanzi Studio's socket, and a synchronous multi-frame encode is
 * what used to make a key press feel unresponsive.
 */
// gifenc ships as CommonJS (its `main`); under Node ESM only the default
// (the CJS namespace) is importable — destructure the helpers from it.
import gifenc from 'gifenc';
import { svgToRgba } from './raster.js';

const { GIFEncoder, quantize, applyPalette } = gifenc;
import { derr } from './log.js';

/**
 * Palette size. The tiles are flat panels plus one glowing border, so they carry
 * far fewer than 256 distinct colors; a smaller table shrinks both the global
 * color table and the LZW code width.
 */
const PALETTE_COLORS = 64;

/** Reserved slot for "transparent" — index 0, unshifted below so it is fixed. */
const TRANSPARENT_INDEX = 0;

export interface AnimSpec {
  /** SVG frame strings (already rendered at the desired animFrame phases). */
  frames: string[];
  /** Per-frame delay in ms. */
  delayMs: number;
}

/** Lets a caller abandon an encode whose deck state is already stale. */
export interface EncodeSignal {
  cancelled: boolean;
}

/**
 * Render the given SVG frames to a single looping GIF, returned as base64
 * (no `data:` prefix), suitable for `$UD.setGifDataIcon`.
 * Returns null on failure, or when `signal` is cancelled mid-encode, so the
 * caller can fall back to a static PNG.
 */
export async function framesToGifBase64(
  spec: AnimSpec,
  size: number,
  signal?: EncodeSignal,
): Promise<string | null> {
  if (spec.frames.length === 0) return null;
  try {
    // Rasterize first, yielding between frames — resvg dominates the cost.
    const images: { data: Uint8Array; width: number; height: number }[] = [];
    for (const frame of spec.frames) {
      if (signal?.cancelled) return null;
      images.push(svgToRgba(frame, size));
      await yieldToEventLoop();
    }

    // One palette for the whole loop, sampled across every frame so a color that
    // only exists at the pulse peak is represented. Slot 0 is forced transparent
    // so delta masking below has a fixed index to write.
    const merged = concatRgba(images);
    const palette = quantize(merged, PALETTE_COLORS - 1, {
      format: 'rgba4444',
      oneBitAlpha: true,
    }).filter((c: number[]) => (c[3] ?? 255) !== 0);
    palette.unshift([0, 0, 0, 0]);

    const gif = GIFEncoder();
    let prev: Uint32Array | null = null;
    for (let i = 0; i < images.length; i++) {
      if (signal?.cancelled) return null;
      const img = images[i];
      const index = applyPalette(img.data, palette, 'rgba4444');
      const cur = new Uint32Array(img.data.buffer, img.data.byteOffset, img.data.length >> 2);
      if (prev) {
        for (let p = 0; p < index.length; p++) {
          if (cur[p] === prev[p]) index[p] = TRANSPARENT_INDEX;
        }
      }
      prev = cur;
      gif.writeFrame(index, img.width, img.height, {
        // Palette on the first frame only: later frames inherit the global color
        // table, and passing it again would emit a redundant local table each time.
        palette: i === 0 ? palette : undefined,
        delay: spec.delayMs,
        transparent: true,
        transparentIndex: TRANSPARENT_INDEX,
        repeat: 0, // loop forever
        first: i === 0,
        dispose: 1, // leave the frame in place — required for delta frames
      });
      await yieldToEventLoop();
    }
    gif.finish();
    return Buffer.from(gif.bytes()).toString('base64');
  } catch (err) {
    derr('gif', `encode failed: ${err}`);
    return null;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function concatRgba(images: { data: Uint8Array }[]): Uint8Array {
  let total = 0;
  for (const img of images) total += img.data.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const img of images) {
    out.set(img.data, at);
    at += img.data.length;
  }
  return out;
}

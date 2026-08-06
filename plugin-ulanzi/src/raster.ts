/**
 * SVG → PNG rasterization for Ulanzi key icons.
 *
 * Mirrors bridge/src/d200h/image-renderer.ts: resvg with EXPLICIT bundled fonts
 * (fontFiles, NOT loadSystemFonts — which would re-scan the OS font tree on every
 * `new Resvg()`). `defaultFontFamily` makes the shared renderers' `Inter`/`Arial`/
 * `monospace` families fall back to a design face instead of dropping all <text>.
 *
 * Ulanzi Studio scales the icon to the key, so we render a fixed square.
 */
import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { derr } from './log.js';

export const ICON_SIZE = 196;

/**
 * Animated tiles rasterize at the renderers' native 144 canvas instead of
 * ICON_SIZE. A GIF carries every frame, so its pixel count is multiplied by the
 * frame count and it is the only payload big enough to congest the Studio→device
 * link; 144 is 1:1 with the SVG viewBox (no upsampling, so no real detail is
 * lost — the plugin's own action icons ship at 96) and cuts an awaiting tile from
 * 73 KB to 47 KB. The brief sharpness difference while a cache-miss key shows its
 * static PNG before the GIF lands is the trade.
 */
export const GIF_ICON_SIZE = 144;

const FONT_OPTS: { fontFiles?: string[]; loadSystemFonts: boolean; defaultFontFamily: string } = (() => {
  try {
    // compiled app lives at <plugin>/plugin/*.js → fonts at <plugin>/resources/fonts
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, '..', 'resources', 'fonts'),
      join(here, '..', '..', 'resources', 'fonts'),
    ];
    for (const fontsDir of candidates) {
      const files = [
        'IBMPlexSans-Regular.ttf',
        'IBMPlexSans-Bold.ttf',
        'JetBrainsMono-Regular.ttf',
        'JetBrainsMono-Bold.ttf',
      ]
        .map((n) => join(fontsDir, n))
        .filter((p) => existsSync(p));
      if (files.length > 0) {
        return { fontFiles: files, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' };
      }
    }
  } catch {
    /* fall through */
  }
  return { loadSystemFonts: true, defaultFontFamily: 'Helvetica Neue' };
})();

/** Rasterize a 144×144 shared-renderer SVG into a square PNG Buffer. */
export function svgToPng(svg144: string, size = ICON_SIZE): Buffer {
  const inner = svg144.replace(/<\/?svg[^>]*>/g, '');
  const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144">${inner}</svg>`;
  try {
    const resvg = new Resvg(wrapped, {
      fitTo: { mode: 'width', value: size },
      font: FONT_OPTS,
    });
    return Buffer.from(resvg.render().asPng());
  } catch (err) {
    derr('raster', `svgToPng failed: ${err}`);
    // 1×1 transparent PNG fallback
    return Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
  }
}

// Cache rasterized PNGs by SVG so toggling list↔detail (and recurring session
// tiles) doesn't re-run resvg every time — resvg raster is the per-render cost.
const pngCache = new Map<string, string>();
const PNG_CACHE_MAX = 256;

/** Rasterize to base64 (no `data:` prefix) for `setBaseDataIcon`, cached by SVG. */
export function svgToBase64Png(svg144: string, size = ICON_SIZE): string {
  const key = `${size}|${svg144}`;
  const hit = pngCache.get(key);
  if (hit !== undefined) return hit;
  const b64 = svgToPng(svg144, size).toString('base64');
  if (pngCache.size >= PNG_CACHE_MAX) {
    // Evict oldest (Map preserves insertion order).
    const first = pngCache.keys().next().value;
    if (first !== undefined) pngCache.delete(first);
  }
  pngCache.set(key, b64);
  return b64;
}

export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Rasterize a 144×144 SVG to raw RGBA pixels (for the GIF encoder). */
export function svgToRgba(svg144: string, size = ICON_SIZE): RgbaImage {
  const inner = svg144.replace(/<\/?svg[^>]*>/g, '');
  const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144">${inner}</svg>`;
  const resvg = new Resvg(wrapped, { fitTo: { mode: 'width', value: size }, font: FONT_OPTS });
  const rendered = resvg.render();
  return {
    data: new Uint8Array(rendered.pixels),
    width: rendered.width,
    height: rendered.height,
  };
}

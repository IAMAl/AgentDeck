import { describe, it, expect } from 'vitest';
import {
  renderGlanceFrameSvg,
  renderGlanceFrame,
  packMono,
  frameSig,
  wmoIconKey,
  GLANCE_FRAME_BOARDS,
} from '../glance-frame.js';
import type { CardFeedGlance } from '@agentdeck/shared';

const GLANCE: CardFeedGlance = {
  weather: {
    place: 'Seongnam',
    tempC: 25,
    code: 3,
    summary: 'Cloudy',
    todayMinC: 22,
    todayMaxC: 31,
    rain: { startHm: '15:00', endHm: '17:00', probability: 70 },
    tomorrow: { code: 61, summary: 'Rain', minC: 25, maxC: 33, rainProbability: 57 },
  },
  usage: [
    { provider: 'claude', label: 'Claude', primaryPercent: 42, primaryResetHm: '12:49', secondaryPercent: 15, stale: false },
    { provider: 'codex', label: 'Codex', secondaryPercent: 55, stale: false },
  ],
  wrapup: ['AgentDeck · fixing OTA flash OOM', '+2 more sessions'],
};

describe('wmoIconKey', () => {
  it('maps WMO code groups to icon keys', () => {
    expect(wmoIconKey(0)).toBe('sun');
    expect(wmoIconKey(2)).toBe('partly');
    expect(wmoIconKey(3)).toBe('cloud');
    expect(wmoIconKey(48)).toBe('fog');
    expect(wmoIconKey(63)).toBe('rain');
    expect(wmoIconKey(81)).toBe('rain');
    expect(wmoIconKey(75)).toBe('snow');
    expect(wmoIconKey(96)).toBe('storm');
    expect(wmoIconKey(undefined)).toBe('cloud');
  });
});

describe('renderGlanceFrameSvg', () => {
  it('lays out the content and escapes markup', () => {
    const svg = renderGlanceFrameSvg({
      glance: { ...GLANCE, wrapup: ['a <b> & "c"'] },
      serverHm: '08:59',
      geometry: GLANCE_FRAME_BOARDS.xteink_x3,
    });
    expect(svg).toContain('25°');
    expect(svg).toContain('Seongnam');
    expect(svg).toContain('Synced 08:59');
    expect(svg).toContain('AI BUDGET');
    expect(svg).toContain('→12:49');
    expect(svg).toContain('Rain 15:00–17:00');
    expect(svg).toContain('a &lt;b&gt; &amp; &quot;c&quot;');
    expect(svg).not.toContain('a <b>');
  });

  it('renders an honest empty state when there is nothing to show', () => {
    const svg = renderGlanceFrameSvg({ serverHm: '', geometry: GLANCE_FRAME_BOARDS.xteink_x4 });
    expect(svg).toContain('No active sessions');
    expect(svg).not.toContain('Synced');
  });
});

describe('packMono', () => {
  it('packs MSB-first with 1 = white', () => {
    // 8×2: first row white, second row black.
    const gray = Buffer.from([...Array(8).fill(255), ...Array(8).fill(0)]);
    const packed = packMono(gray, 8, 2);
    expect(packed.length).toBe(2);
    expect(packed[0]).toBe(0xff);
    expect(packed[1]).toBe(0x00);
  });

  it('pads row tails to byte boundaries', () => {
    const gray = Buffer.alloc(10, 255); // 10×1 all white
    const packed = packMono(gray, 10, 1);
    expect(packed.length).toBe(2);
    expect(packed[0]).toBe(0xff);
    expect(packed[1]).toBe(0xc0); // only the top 2 bits belong to pixels
  });

  it('dithers mid-gray into a stable ordered pattern', () => {
    const gray = Buffer.alloc(8 * 4, 128);
    const a = packMono(gray, 8, 4);
    const b = packMono(gray, 8, 4);
    expect(a.equals(b)).toBe(true); // deterministic
    const ones = [...a].reduce((n, byte) => n + byte.toString(2).split('1').length - 1, 0);
    expect(ones).toBeGreaterThan(8); // neither all black…
    expect(ones).toBeLessThan(24); // …nor all white
  });
});

describe('renderGlanceFrame', () => {
  it('produces the exact framebuffer size with a stable sig for stable input', async () => {
    const input = { glance: GLANCE, serverHm: '08:59', geometry: GLANCE_FRAME_BOARDS.xteink_x3 };
    const a = await renderGlanceFrame(input);
    const b = await renderGlanceFrame(input);
    expect(a.packed.length).toBe((528 / 8) * 792);
    expect(a.sig).toBe(b.sig);
    expect(a.sig).toBe(frameSig(a.packed));
  });

  it('landscape preset fills the X4 framebuffer', async () => {
    const f = await renderGlanceFrame({ glance: GLANCE, serverHm: '09:00', geometry: GLANCE_FRAME_BOARDS.xteink_x4 });
    expect(f.packed.length).toBe((800 / 8) * 480);
    const png = await f.png();
    expect(png.subarray(1, 4).toString()).toBe('PNG');
  });
});

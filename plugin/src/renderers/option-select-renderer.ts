/**
 * Option-select touch-strip renderer (Stream Deck+).
 *
 * Draws the agent's pending choice list across the WHOLE 800×100 touch strip
 * rather than one dial's 200px slice — an option label is the thing that needs
 * room, and 200px truncates almost every real one.
 *
 * The SDK exposes no single wide surface: each encoder gets its own 200×100
 * feedback canvas. So the design is laid out once across the dials the user
 * actually placed and each one emits its window onto it — the slicing
 * convention `renderOfflineTouchStrip` uses, but sized to the placement rather
 * than assuming all four. One dial gets a 200px layout that still reads; four
 * adjacent dials get the full 800px strip. Sizing to a fixed 800 instead would
 * show a lone dial a meaningless quarter of a sentence.
 */
import { State, measureTextWidth, sliceByPx, type PromptOption } from '@agentdeck/shared';

/** One encoder's LCD. The layout spans however many are placed, side by side. */
const SLICE_W = 200;
const H = 100;

/** Which dials this render covers, and which of them is being painted. */
export interface StripPlacement {
  /** Physical column (0-3) of the dial being painted. */
  column: number;
  /** Leftmost column carrying this action. */
  spanStart: number;
  /** How many columns the layout spans (>=1). */
  spanCols: number;
}

/** Layout width for a placement. */
function widthOf(p: StripPlacement): number {
  return Math.max(1, p.spanCols) * SLICE_W;
}

const HEADER_H = 22;
const ROW_H = 25;
const ROWS = 3;
/** Right-hand gutter reserved for the scroll thumb. */
const GUTTER = 8;

/**
 * Option labels are the agent's own text and are routinely non-Latin — this
 * user's are Japanese. `Arial, sans-serif` has no CJK coverage, so the LCD
 * renders tofu boxes. Name the platform CJK faces explicitly rather than
 * trusting the rasteriser's fallback.
 */
const FONT = "'Segoe UI','Yu Gothic UI',Meiryo,'Hiragino Sans','Noto Sans CJK JP','Apple SD Gothic Neo','Microsoft YaHei',Arial,sans-serif";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wrap the 800-wide content in a 200-wide window for one dial.
 *
 * The background is painted in slice-space, not translated with the content —
 * otherwise every dial past the first would show bare canvas beyond x=800.
 */
function sliceWrap(content: string, p: StripPlacement): string {
  const offsetX = -(p.column - p.spanStart) * SLICE_W;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SLICE_W}" height="${H}" viewBox="0 0 ${SLICE_W} ${H}">`,
    `<rect width="${SLICE_W}" height="${H}" fill="#0f172a"/>`,
    `<g transform="translate(${offsetX} 0)">${content}</g>`,
    `</svg>`,
  ].join('');
}

function truncateByPx(str: string, maxPx: number, fontSize: number): string {
  if (measureTextWidth(str, fontSize) <= maxPx) return str;
  const ellipsisPx = measureTextWidth('…', fontSize);
  const [fit] = sliceByPx(str, maxPx - ellipsisPx, fontSize);
  return fit + '…';
}

function headerFor(state: State, question?: string): { title: string; accent: string } {
  switch (state) {
    case State.AWAITING_PERMISSION:
      return { title: question || 'Permission', accent: '#f59e0b' };
    case State.AWAITING_DIFF:
      return { title: question || 'Review diff', accent: '#38bdf8' };
    default:
      return { title: question || 'Choose', accent: '#a78bfa' };
  }
}

export interface OptionSelectView {
  state: State;
  options: PromptOption[];
  cursorIndex: number;
  question?: string;
  /** Multi-select mode: rows get checkboxes and the header shows the tally. */
  multiSelect?: boolean;
  /** Indices ticked on the device but not yet submitted. Ignored unless
   *  `multiSelect` — a single-choice prompt has nothing to accumulate. */
  checked?: ReadonlySet<number>;
}

/**
 * Idle face — no pending choice.
 *
 * Drawn per dial rather than once across the span: a centred sentence spanning
 * four LCDs leaves a lone dial showing a fragment like "ompt", which reads as a
 * rendering fault rather than as "nothing to answer".
 */
export function renderOptionSelectIdle(_p: StripPlacement): string {
  const mid = SLICE_W / 2;
  const content =
    `<text x="${mid}" y="48" text-anchor="middle" font-family="${FONT}" font-size="13" fill="#475569">no prompt</text>` +
    `<text x="${mid}" y="68" text-anchor="middle" font-family="${FONT}" font-size="10" fill="#334155">waiting for the agent</text>`;
  // Deliberately NOT sliceWrap: this content is already in slice space.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SLICE_W}" height="${H}" viewBox="0 0 ${SLICE_W} ${H}">`,
    `<rect width="${SLICE_W}" height="${H}" fill="#0f172a"/>`,
    content,
    `</svg>`,
  ].join('');
}

/** The layout across the placed dials, windowed to one of them. */
export function renderOptionSelect(view: OptionSelectView, p: StripPlacement): string {
  const { state, options, question } = view;
  if (options.length === 0) return renderOptionSelectIdle(p);
  const W = widthOf(p);

  // A cursor arriving from a shrunken list must never index off the end.
  const cursor = Math.min(Math.max(view.cursorIndex, 0), options.length - 1);
  const { title, accent } = headerFor(state, question);

  let windowStart = 0;
  if (options.length > ROWS) {
    windowStart = Math.max(0, cursor - Math.floor(ROWS / 2));
    windowStart = Math.min(windowStart, options.length - ROWS);
  }

  let content = '';

  // ── Header: accent bar, question, counter/tally ──
  content += `<rect x="0" y="0" width="${W}" height="${HEADER_H}" fill="#1e293b"/>`;
  content += `<rect x="0" y="0" width="4" height="${HEADER_H}" fill="${accent}"/>`;
  // In multi-select the useful number is how many are ticked, not where the
  // cursor sits — the cursor is a means, the tally is the answer being built.
  // Colour the counter by readiness: a tap only submits once something is
  // ticked, so an empty answer reads muted ("press to select") and a non-empty
  // one turns green ("N selected · tap to submit") to show the tap is now live.
  const ticks = view.checked?.size ?? 0;
  const ready = view.multiSelect === true && ticks > 0;
  const counter = view.multiSelect
    ? (ready ? `${ticks} selected · tap to submit` : 'press to select')
    : `${cursor + 1} / ${options.length}`;
  const counterColor = ready ? '#86efac' : '#64748b';
  const counterPx = measureTextWidth(counter, 12);
  content += `<text x="${W - 10}" y="15" text-anchor="end" font-family="${FONT}" font-size="12" fill="${counterColor}">${escapeXml(counter)}</text>`;
  content += `<text x="12" y="15" font-family="${FONT}" font-size="12" font-weight="bold" fill="${accent}">${escapeXml(truncateByPx(title, W - 32 - counterPx, 12))}</text>`;

  // ── Rows: full strip width, which is the whole point of this layout ──
  const hasThumb = options.length > ROWS;
  const rowW = W - 8 - (hasThumb ? GUTTER : 0);
  const labelPx = rowW - 30;
  for (let i = 0; i < ROWS; i++) {
    const optIdx = windowStart + i;
    if (optIdx >= options.length) break;

    const opt = options[optIdx];
    const isCursor = optIdx === cursor;
    const y = HEADER_H + 1 + i * ROW_H;
    const baseY = y + 17;
    const x = isCursor ? 12 : 24;
    const prefix = isCursor ? '▶ ' : '';

    // Cursor highlight sits under whatever text renders on top of it.
    if (isCursor) {
      content += `<rect x="4" y="${y}" width="${rowW}" height="${ROW_H - 2}" rx="4" fill="#1e3a5f"/>`;
    }

    if (view.multiSelect) {
      // The tick box is its own coloured glyph so a checked row pops (green ☑)
      // without recolouring the label; the row number is dropped because the box
      // is the state. `recommended`/`selected` are the agent's own hints and
      // stay legible; a device-side tick (bright label) outranks both.
      const ticked = view.checked?.has(optIdx) === true;
      const boxChar = ticked ? '☑' : '☐';
      const boxColor = ticked ? '#86efac' : '#64748b';
      const labelColor = isCursor ? '#ffffff' : ticked ? '#e2e8f0' : opt.recommended ? '#86efac' : opt.selected ? '#93c5fd' : '#94a3b8';
      const usedPx = measureTextWidth(`${prefix}${boxChar} `, 14);
      const labelText = escapeXml(truncateByPx(opt.label, Math.max(20, labelPx - usedPx), 14));
      content += `<text x="${x}" y="${baseY}" font-family="${FONT}" font-size="14"${isCursor ? ' font-weight="bold"' : ''}>`
        + (prefix ? `<tspan fill="#ffffff">${prefix}</tspan>` : '')
        + `<tspan fill="${boxColor}">${boxChar} </tspan>`
        + `<tspan fill="${labelColor}">${labelText}</tspan>`
        + `</text>`;
    } else {
      const label = `${prefix}${optIdx + 1}. ${opt.label}`;
      const textColor = isCursor ? '#ffffff' : opt.recommended ? '#86efac' : opt.selected ? '#93c5fd' : '#94a3b8';
      content += `<text x="${x}" y="${baseY}" font-family="${FONT}" font-size="14"${isCursor ? ' font-weight="bold"' : ''} fill="${textColor}">${escapeXml(truncateByPx(label, labelPx, 14))}</text>`;
    }
  }

  // ── Scroll thumb ──
  if (hasThumb) {
    const trackY = HEADER_H + 1;
    const trackH = H - trackY - 3;
    const thumbH = Math.max(12, (ROWS / options.length) * trackH);
    const thumbY = trackY + (windowStart / (options.length - ROWS)) * (trackH - thumbH);
    content += `<rect x="${W - 7}" y="${trackY}" width="4" height="${trackH}" rx="2" fill="#1e293b"/>`;
    content += `<rect x="${W - 7}" y="${thumbY}" width="4" height="${thumbH}" rx="2" fill="#475569"/>`;
  }

  return sliceWrap(content, p);
}

/**
 * Option-select touch-strip renderer — multi-select UX affordances.
 *
 * The dial's multi-select interaction is press-to-tick / tap-to-submit, and an
 * empty tap does nothing. These assertions pin the visual cues that tell the
 * user which state they're in: the header counter is muted until something is
 * ticked and turns green ("tap to submit") once a tap would actually submit,
 * and a ticked row's checkbox is drawn green so selections read at a glance.
 */
import { describe, it, expect } from 'vitest';
import { State, type PromptOption } from '@agentdeck/shared';
import { renderOptionSelect, type StripPlacement } from '../renderers/option-select-renderer.js';

const FULL: StripPlacement = { column: 0, spanStart: 0, spanCols: 4 };
const READY_GREEN = '#86efac';
const MUTED = '#64748b';
const opts = (labels: string[]): PromptOption[] => labels.map((label, i) => ({ index: i, label }));

const multi = (checked: number[], cursorIndex = 0) => renderOptionSelect({
  state: State.AWAITING_OPTION,
  options: opts(['ESLint', 'Prettier', 'Vitest']),
  cursorIndex,
  question: 'Pick features',
  multiSelect: true,
  checked: new Set(checked),
}, FULL);

describe('renderOptionSelect multi-select affordances', () => {
  it('reads muted "press to select" when nothing is ticked', () => {
    const svg = multi([]);
    expect(svg).toContain('press to select');
    expect(svg).not.toContain('tap to submit');
    // The counter is drawn muted, not green, so an empty answer never looks live.
    expect(svg).toMatch(new RegExp(`fill="${MUTED}"[^>]*>press to select`));
    expect(svg).not.toContain(READY_GREEN + '"'); // no green anywhere with 0 ticked
  });

  it('turns green "N selected · tap to submit" once something is ticked', () => {
    const svg = multi([0, 2]);
    expect(svg).toContain('2 selected · tap to submit');
    expect(svg).toMatch(new RegExp(`fill="${READY_GREEN}"[^>]*>2 selected · tap to submit`));
  });

  it('draws a ticked row\'s checkbox green and an unticked one muted', () => {
    const svg = multi([0]); // ESLint ticked, others not
    // A green ☑ tspan for the ticked row, a muted ☐ tspan for unticked rows.
    expect(svg).toMatch(new RegExp(`<tspan fill="${READY_GREEN}">☑ </tspan>`));
    expect(svg).toMatch(new RegExp(`<tspan fill="${MUTED}">☐ </tspan>`));
  });

  it('single-select keeps the numbered rows and the N / M counter', () => {
    const svg = renderOptionSelect({
      state: State.AWAITING_OPTION,
      options: opts(['Yes', 'No']),
      cursorIndex: 0,
      question: 'Run?',
    }, FULL);
    expect(svg).toContain('1 / 2');
    expect(svg).toContain('1. Yes');
    expect(svg).not.toContain('☑');
    expect(svg).not.toContain('tap to submit');
  });
});

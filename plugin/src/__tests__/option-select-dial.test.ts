/**
 * Option-select dial input logic (Stream Deck+ encoder).
 *
 * Drives the exported rotate/press/tap handlers directly — the same bodies the
 * dedicated dial and the borrowed default dials both route through — and pins
 * the wire commands they emit. The renderer has its own snapshot coverage; this
 * file is about the state machine, especially multi-select accumulation:
 *   - single press  → `select_option` (one shot, clears the prompt)
 *   - permission    → `permission_decision` (index 0 = allow, else deny)
 *   - multi press   → toggles a local tick, emits NOTHING on the wire
 *   - multi tap     → `select_options` with the accumulated indices
 *   - empty tap     → swallowed (an empty submit reads as a decline downstream)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The action module reaches for the SDK at import (the @action decorator) and in
// every paint (getActionById). None of that is under test here, so stub it to a
// no-op: getActionById returns nothing, so paint loops skip cleanly.
vi.mock('@elgato/streamdeck', () => {
  class SingletonAction {}
  const noopScope = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  const logger = { setLevel() {}, createScope: () => noopScope };
  return {
    default: { actions: { getActionById: () => undefined }, logger },
    action: () => () => {},
    SingletonAction,
  };
});

import { State, type PromptOption } from '@agentdeck/shared';
import {
  initOptionSelectDial,
  updateOptionSelectDial,
  optionSelectRotate,
  optionSelectPress,
  optionSelectTap,
} from '../actions/option-select-dial.js';
import { setEncoderDaemonConnected } from '../encoder-registry.js';

type Cmd = { type: string; [k: string]: unknown };
let sent: Cmd[];

function opts(labels: string[], selected?: number[]): PromptOption[] {
  const sel = new Set(selected ?? []);
  return labels.map((label, i) => ({ index: i, label, selected: sel.has(i) }));
}

beforeEach(() => {
  sent = [];
  initOptionSelectDial((c) => sent.push(c as Cmd));
  setEncoderDaemonConnected(true);
  // Clear any prompt carried over from a previous test.
  updateOptionSelectDial(State.IDLE, [], 0);
  sent = [];
});

describe('single-select', () => {
  it('press emits select_option with the displayed cursor and question', () => {
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B', 'C']), 1, 'Q?');
    optionSelectPress();
    expect(sent).toEqual([{ type: 'select_option', index: 1, question: 'Q?' }]);
  });

  it('rotate clamps at the ends and only navigates when the cursor moves', () => {
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B', 'C']), 0, 'Q?');
    optionSelectRotate(-1); // already at the top — no move, no keystroke
    expect(sent).toEqual([]);
    optionSelectRotate(1); // → cursor 1
    optionSelectRotate(1); // → cursor 2
    optionSelectRotate(1); // clamped at the bottom — no move
    expect(sent).toEqual([
      { type: 'navigate_option', direction: 'down' },
      { type: 'navigate_option', direction: 'down' },
    ]);
  });

  it('press clears the prompt so a second press hits nothing', () => {
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B']), 0, 'Q?');
    optionSelectPress();
    optionSelectPress(); // prompt already answered
    expect(sent).toHaveLength(1);
  });
});

describe('permission gate', () => {
  it('index 0 allows, anything else denies, and echoes the requestId', () => {
    updateOptionSelectDial(State.AWAITING_PERMISSION, opts(['Allow', 'Always', 'Deny']), 0, 'Run?', 'req-1');
    optionSelectPress();
    expect(sent).toEqual([{ type: 'permission_decision', requestId: 'req-1', decision: 'allow' }]);

    sent = [];
    updateOptionSelectDial(State.AWAITING_PERMISSION, opts(['Allow', 'Always', 'Deny']), 2, 'Run?', 'req-2');
    optionSelectPress();
    expect(sent).toEqual([{ type: 'permission_decision', requestId: 'req-2', decision: 'deny' }]);
  });
});

describe('multi-select', () => {
  it('press toggles a local tick and emits nothing until the tap', () => {
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B', 'C', 'D']), 0, 'Pick', undefined, true);
    optionSelectPress();           // tick idx 0
    optionSelectRotate(1);         // cursor → 1 (navigate_option only)
    optionSelectRotate(1);         // cursor → 2
    optionSelectPress();           // tick idx 2
    // Nothing but navigation on the wire so far.
    expect(sent.filter((c) => c.type !== 'navigate_option')).toEqual([]);

    optionSelectTap();
    expect(sent.at(-1)).toEqual({ type: 'select_options', indices: [0, 2], question: 'Pick' });
  });

  it('toggling the same index twice removes it', () => {
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B']), 0, 'Pick', undefined, true);
    optionSelectPress(); // tick 0
    optionSelectPress(); // untick 0
    optionSelectRotate(1);
    optionSelectPress(); // tick 1
    optionSelectTap();
    expect(sent.at(-1)).toEqual({ type: 'select_options', indices: [1], question: 'Pick' });
  });

  it('an empty tap is swallowed and keeps the prompt on screen', () => {
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B']), 0, 'Pick', undefined, true);
    optionSelectTap(); // nothing ticked
    expect(sent).toEqual([]);
    // Prompt still live: a real answer still goes through.
    optionSelectPress();
    optionSelectTap();
    expect(sent.at(-1)).toEqual({ type: 'select_options', indices: [0], question: 'Pick' });
  });

  it('tap is inert for a single-choice prompt (commit is on press)', () => {
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B']), 0, 'Q?', undefined, false);
    optionSelectTap();
    expect(sent).toEqual([]);
  });

  it('seeds the tick set from options already selected in the TUI', () => {
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B', 'C'], [1]), 0, 'Pick', undefined, true);
    optionSelectTap(); // idx 1 was pre-checked, so this is a non-empty submit
    expect(sent.at(-1)).toEqual({ type: 'select_options', indices: [1], question: 'Pick' });
  });
});

describe('tick carry across re-emits (bridge re-sends on every cursor move)', () => {
  it('preserves ticks while the question is unchanged', () => {
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B', 'C']), 0, 'Same Q', undefined, true);
    optionSelectPress(); // tick 0
    // Bridge re-emits the SAME question with a moved cursor — must keep tick 0.
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B', 'C']), 2, 'Same Q', undefined, true);
    optionSelectPress(); // tick 2
    optionSelectTap();
    expect(sent.at(-1)).toEqual({ type: 'select_options', indices: [0, 2], question: 'Same Q' });
  });

  it('resets ticks when the question text changes', () => {
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B']), 0, 'Q1', undefined, true);
    optionSelectPress(); // tick 0 under Q1
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B']), 0, 'Q2', undefined, true);
    optionSelectTap(); // fresh question, nothing ticked → swallowed
    expect(sent).toEqual([]);
  });

  it('resets ticks when the option set changes under identical question text', () => {
    // Two sub-questions of one AskUserQuestion can share wording; the option
    // set is what distinguishes them, so ticks must NOT leak across.
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['Red', 'Green']), 0, 'Pick one', undefined, true);
    optionSelectPress(); // tick 0 (Red) under the first question
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['Cat', 'Dog']), 0, 'Pick one', undefined, true);
    optionSelectTap(); // different options → nothing carried → swallowed
    expect(sent).toEqual([]);
  });

  it('still carries ticks when question and options are unchanged', () => {
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B', 'C']), 0, 'Pick one', undefined, true);
    optionSelectPress(); // tick 0
    // Same question AND same options, cursor moved — a genuine re-emit.
    updateOptionSelectDial(State.AWAITING_OPTION, opts(['A', 'B', 'C']), 1, 'Pick one', undefined, true);
    optionSelectTap();
    expect(sent.at(-1)).toEqual({ type: 'select_options', indices: [0], question: 'Pick one' });
  });
});

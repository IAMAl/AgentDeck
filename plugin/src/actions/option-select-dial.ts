/**
 * Option-select dial (Stream Deck+ encoder).
 *
 * Answers the agent's pending choice from a dial: ROTATE moves the cursor,
 * PRESS commits the highlighted option. The three AWAITING_* states all route
 * here — AskUserQuestion lists, tool-permission prompts, and diff review.
 *
 * Why a dedicated action rather than the retired takeover: the pre-7e10292f
 * design commandeered E1–E4 whenever a prompt appeared, which required
 * cross-module callback cycles and fought the permanent usage gauges. This one
 * owns a single encoder the user assigns, so nothing else has to yield.
 *
 * Two wire shapes, picked by whether the daemon gated the prompt:
 *   - `requestId` present → PreToolUse permission gate → `permission_decision`
 *   - otherwise           → `select_option` (bridge converts index → keystrokes)
 * See shared/src/protocol.ts (StateUpdateEvent.requestId).
 */
import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  TouchTapEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State, type PromptOption } from '@agentdeck/shared';
import { encoderRegistry, isDaemonConnected } from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderOptionSelect, renderOptionSelectIdle, type StripPlacement } from '../renderers/option-select-renderer.js';
import { renderOfflineTouchStrip } from '../renderers/session-slot-renderer.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import { dinfo } from '../log.js';

const PIXMAP_LAYOUT = 'layouts/encoder-layout.json';

type SendCommand = (command: { type: string; [key: string]: unknown }) => void;

/** Injected by plugin.ts — importing it directly would close a dependency cycle. */
let sendCommand: SendCommand | null = null;

interface PendingPrompt {
  state: State;
  options: PromptOption[];
  cursorIndex: number;
  question?: string;
  /** Set only for daemon-gated PreToolUse permissions. */
  requestId?: string;
  /** The question takes several answers — press toggles, tap submits. */
  multiSelect: boolean;
  /** Ticked on the device, not yet submitted. Seeded from whatever the TUI
   *  already had checked so a partial answer isn't silently discarded. */
  checked: Set<number>;
}

let pending: PendingPrompt | null = null;
let currentLayout = '';

export function initOptionSelectDial(send: SendCommand): void {
  sendCommand = send;
}

/**
 * Called from plugin.ts on every broadcast. Clears the face as soon as the
 * agent leaves an AWAITING_* state so an answered prompt can't linger and
 * invite a press that would land on whatever comes next.
 */
export function updateOptionSelectDial(
  state: State,
  options: PromptOption[],
  cursorIndex: number,
  question?: string,
  requestId?: string,
  multiSelect?: boolean,
): void {
  // Gate on having options, NOT on the state being AWAITING_*. `prompt_options`
  // can land before the matching `state_update`, and requiring both dropped the
  // list on exactly the arrival order the daemon uses for relayed sessions. The
  // plugin already clears `currentOptions` when the agent leaves an awaiting
  // state, so "no options" remains the authoritative "nothing to answer".
  if (options.length === 0) {
    pending = null;
    refresh();
    return;
  }

  // Carry the tick set across state updates for the SAME question — the bridge
  // re-emits on every cursor move, and rebuilding the set each time would erase
  // everything the user ticked between the first press and the confirm tap.
  const sameQuestion = pending?.question === question && pending?.multiSelect === true;
  const checked = sameQuestion && pending
    ? pending.checked
    : new Set(options.filter((o) => o.selected === true).map((o) => o.index));

  pending = {
    state,
    options,
    cursorIndex,
    question,
    requestId,
    multiSelect: multiSelect === true,
    checked,
  };
  refresh();
}

/** Physical dial position (0-3) per action id. The strip design is laid out in
 *  800-space and each dial shows the window at its own column, so a wrong
 *  column shows the wrong slice — never fall back to registration order. */
const columnById = new Map<string, number>();
/** Last logged span, so the info log records changes rather than every repaint. */
let lastSpanKey = '';

function ensurePixmapLayout(): void {
  if (currentLayout === PIXMAP_LAYOUT) return;
  currentLayout = PIXMAP_LAYOUT;
  for (const id of encoderRegistry.optionSelectIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {});
  }
}

/** Contiguous span the layout is laid out across — the placed dials, not a
 *  fixed four. A lone dial then gets a 200px layout that still reads instead of
 *  a quarter of an 800px one. */
function currentSpan(): { spanStart: number; spanCols: number } {
  const cols = encoderRegistry.optionSelectIds
    .map((id) => columnById.get(id))
    .filter((c): c is number => typeof c === 'number');
  if (cols.length === 0) return { spanStart: 0, spanCols: 1 };
  const spanStart = Math.min(...cols);
  // Span the extremes rather than counting dials: two dials placed at columns 0
  // and 3 are not a 400px strip, and laying out as if they were would put the
  // right half of the design on the wrong LCD.
  return { spanStart, spanCols: Math.max(...cols) - spanStart + 1 };
}

/** Each dial paints its own window onto the shared layout. */
function paint(render: (p: StripPlacement) => string): void {
  const span = currentSpan();
  const spanKey = `${span.spanStart}+${span.spanCols}/${encoderRegistry.optionSelectIds.length}`;
  if (spanKey !== lastSpanKey) {
    lastSpanKey = spanKey;
    dinfo('OptionSelectDial', `layout span=${span.spanStart}+${span.spanCols} dials=${encoderRegistry.optionSelectIds.length} width=${span.spanCols * 200}px`);
  }
  for (const id of encoderRegistry.optionSelectIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (!dial) continue;
    const column = columnById.get(id) ?? span.spanStart;
    void dial.setFeedback({ canvas: svgToDataUrl(render({ column, ...span })) }).catch(() => {});
  }
}

function refresh(): void {
  if (isDisplayDimmed()) return;
  if (encoderRegistry.optionSelectIds.length === 0) return;
  ensurePixmapLayout();

  if (!isDaemonConnected()) {
    // The offline banner is its own all-or-nothing 800px design; slice it the
    // same way so a dial showing it lines up with the other three.
    // The offline banner is its own fixed 800px design, so it is sliced by raw
    // column — it does not participate in the placement-sized layout above.
    paint((p) => renderOfflineTouchStrip(p.column));
    return;
  }
  const snapshot = pending;
  paint((p) => (snapshot ? renderOptionSelect(snapshot, p) : renderOptionSelectIdle(p)));
}

/** Redraw on daemon connect/disconnect (offline banner). */
export function refreshOptionSelectDial(): void {
  if (!isDaemonConnected()) pending = null;
  refresh();
}

@action({ UUID: 'bound.serendipity.agentdeck.option-select-dial' })
export class OptionSelectDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.optionSelectIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!encoderRegistry.optionSelectIds.includes(ev.action.id)) {
      encoderRegistry.optionSelectIds.push(ev.action.id);
    }
    // Physical column drives which window of the layout this dial paints.
    // Fall back to registration order when the payload carries no coordinates:
    // defaulting every dial to 0 would make all four paint the SAME 200px
    // window, which looks exactly like "the layout never widened".
    const reported = (ev.payload as any)?.coordinates?.column;
    const column = typeof reported === 'number'
      ? reported
      : Math.max(0, encoderRegistry.optionSelectIds.indexOf(ev.action.id));
    columnById.set(ev.action.id, column);
    dinfo('OptionSelectDial', `onWillAppear: id=${ev.action.id} controller=${(ev.payload as any)?.controller} col=${column}${typeof reported === 'number' ? '' : ' (no coordinates — using order)'} placed=${encoderRegistry.optionSelectIds.length}`);
    currentLayout = PIXMAP_LAYOUT;
    if (dimActionIfNeeded(ev.action, 'Encoder')) return;
    refresh();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (!isDaemonConnected() || !pending || !sendCommand) return;

    const dir = ev.payload.ticks >= 0 ? 'down' : 'up';
    const next = dir === 'down'
      ? Math.min(pending.cursorIndex + 1, pending.options.length - 1)
      : Math.max(pending.cursorIndex - 1, 0);
    if (next === pending.cursorIndex) return;  // already at an end — don't emit a keystroke

    // Move optimistically so the LCD tracks the dial; the bridge mirrors the
    // same clamp and echoes the authoritative cursor back on the next state
    // update. Sending navigate_option (rather than only moving locally) keeps
    // the terminal's own cursor in step, which is what makes `select_option`'s
    // delta arithmetic land on the right row.
    pending.cursorIndex = next;
    refresh();
    sendCommand({ type: 'navigate_option', direction: dir });
    dinfo('OptionSelectDial', `rotate ${dir} → cursor=${next}/${pending.options.length}`);
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (!isDaemonConnected() || !pending || !sendCommand) return;

    const { cursorIndex, question, requestId, options } = pending;
    const choice = options[cursorIndex];

    // Multi-select: the press builds the answer, it doesn't submit it. Nothing
    // goes on the wire until the touch-strip tap, so the TUI stays untouched
    // while the user is still deciding.
    if (pending.multiSelect) {
      if (pending.checked.has(cursorIndex)) pending.checked.delete(cursorIndex);
      else pending.checked.add(cursorIndex);
      dinfo('OptionSelectDial', `toggle idx=${cursorIndex} → ${pending.checked.size} checked`);
      refresh();
      return;
    }

    if (requestId) {
      // Daemon-gated PreToolUse permission: answer the gate, not the TUI.
      // Anything that isn't the affirmative first option is a deny — the
      // permission list is allow / allow-always / deny.
      sendCommand({ type: 'permission_decision', requestId, decision: cursorIndex === 0 ? 'allow' : 'deny' });
      dinfo('OptionSelectDial', `press → permission_decision idx=${cursorIndex} req=${requestId}`);
    } else {
      // Echo the question the dial was DISPLAYING: a multi-question
      // AskUserQuestion advances as soon as one is answered, and without the
      // echo this index would be applied to the next question's list.
      sendCommand({
        type: 'select_option',
        index: cursorIndex,
        ...(question ? { question } : {}),
      });
      dinfo('OptionSelectDial', `press → select_option idx=${cursorIndex} "${choice?.label ?? ''}"`);
    }

    // Blank immediately rather than waiting for the state update — the prompt
    // is answered, and a second press on a stale list would hit the next one.
    pending = null;
    refresh();
  }

  /** Touch strip = submit the accumulated multi-select answer. */
  override async onTouchTap(_ev: TouchTapEvent): Promise<void> {
    if (!isDaemonConnected() || !pending || !sendCommand) return;
    if (!pending.multiSelect) return;  // single-choice prompts commit on press

    const { question, checked } = pending;

    // Nothing ticked — swallow the tap rather than submitting an empty answer.
    // Downstream an empty submit is a bare Enter on the picker, which the agent
    // records as a decline, so a stray tap would throw the question away. Keep
    // `pending` so the prompt stays on the strip and the user can still answer.
    if (checked.size === 0) {
      dinfo('OptionSelectDial', 'tap ignored: nothing ticked (an empty submit would read as a decline)');
      return;
    }

    const indices = [...checked].sort((a, b) => a - b);
    sendCommand({
      type: 'select_options',
      indices,
      ...(question ? { question } : {}),
    });
    dinfo('OptionSelectDial', `tap → select_options [${indices.join(',')}]`);

    pending = null;
    refresh();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = encoderRegistry.optionSelectIds.indexOf(ev.action.id);
    if (idx !== -1) encoderRegistry.optionSelectIds.splice(idx, 1);
    columnById.delete(ev.action.id);
  }
}

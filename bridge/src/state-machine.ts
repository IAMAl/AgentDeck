import { EventEmitter } from 'events';
import {
  State,
  PermissionMode,
  STUCK_TIMEOUT_MS,
  type StateSnapshot,
  type PromptOption,
  type StateTransition,
  transitions,
} from './types.js';
import type { BillingType } from '@agentdeck/shared';
import { UsageTracker } from './usage-tracker.js';
import { debug } from './logger.js';

/** Extract the most useful field from tool_input for display on E4 */
function formatToolInput(toolName: string | null, input: Record<string, unknown> | undefined): string | null {
  if (!input || !toolName) return null;

  // Tool-specific key extraction
  const keyMap: Record<string, string> = {
    Bash: 'command',
    Read: 'file_path',
    Write: 'file_path',
    Edit: 'file_path',
    Glob: 'pattern',
    Grep: 'pattern',
    WebFetch: 'url',
    WebSearch: 'query',
    Task: 'prompt',
  };

  const key = keyMap[toolName];
  if (key && typeof input[key] === 'string') {
    return truncateToolInput(input[key] as string);
  }

  // Fallback: first short string value
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.length > 0 && v.length < 200) {
      return truncateToolInput(v);
    }
  }
  return null;
}

function truncateToolInput(s: string): string {
  // Take first line, max 120 chars
  const line = s.split('\n')[0];
  return line.length > 120 ? line.slice(0, 119) + '\u2026' : line;
}

export class StateMachine extends EventEmitter {
  private state: State = State.DISCONNECTED;
  private permissionMode: PermissionMode = PermissionMode.DEFAULT;
  private currentTool: string | null = null;
  private toolInput: string | null = null;
  private toolProgress: string | null = null;
  private options: PromptOption[] = [];
  private question: string | null = null;
  /** Question groups from the last AskUserQuestion PreToolUse input, each with
   *  its own options. One call carries up to four groups presented one at a
   *  time. `multiSelect` is never inferred from the TUI — `✔` also marks the
   *  current choice in single-select lists like `/model`. For a MULTI-group
   *  prompt the option list is driven from here rather than the parser, which
   *  can't isolate a later group from the accumulating TUI buffer. */
  private askGroups: AskGroup[] = [];
  /** Which group of a multi-group AskUserQuestion is on screen. Advanced by the
   *  device answering a non-final group (`advanceToNextGroup`); reset per call. */
  private activeGroupIndex = 0;
  /** The parser saw `[ ]`/`[x]` boxes on the list currently rendered. This is
   *  direct evidence from the screen, so it outranks the hook lookup, which can
   *  miss when the TUI's question text differs from the tool input's. */
  private parsedMultiSelect = false;
  private navigable = false;
  private cursorIndex = 0;
  private cursorAuthority: 'pty' | 'optimistic' = 'pty';
  private optimisticCursorTime = 0;
  private projectName: string | null = null;
  private modelName: string | null = null;
  private effortLevel: string | null = null;
  private remoteUrl: string | null = null;
  private billingType: BillingType = 'unknown';
  private suggestedPrompt: string | null = null;
  private lastValidSuggestedPrompt: string | null = null;
  private usageTracker: UsageTracker;
  private stuckTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(usageTracker: UsageTracker) {
    super();
    this.usageTracker = usageTracker;
  }

  handleHookEvent(eventName: string, data: Record<string, unknown>): void {
    debug('SM', `hookEvent: ${eventName} (current: ${this.state})`);
    switch (eventName) {
      case 'SessionStart':
        this.usageTracker.start();
        this.transition(State.IDLE, 'session_start', 'hook');
        break;

      case 'UserPromptSubmit':
        this.suggestedPrompt = null;
        this.lastValidSuggestedPrompt = null;
        this.transition(State.PROCESSING, 'user_prompt_submit', 'hook');
        break;

      case 'PreToolUse': {
        const toolName = (data.tool_name as string) || null;
        const toolInputData = data.tool_input as Record<string, unknown> | undefined;
        this.currentTool = toolName;
        this.toolInput = formatToolInput(toolName, toolInputData);
        this.toolProgress = `Using ${toolName}`;
        if (toolName === 'AskUserQuestion') {
          // The tool input is the only trustworthy source for multiSelect (the
          // TUI renders the same `✔` for a single-select current choice) and for
          // each group's options (later groups can't be scraped off the TUI).
          this.askGroups = collectAskGroups(toolInputData);
          this.activeGroupIndex = 0;
        }
        this.emitSnapshot();
        break;
      }

      case 'PostToolUse': {
        this.usageTracker.addToolCall(data);
        this.currentTool = null;
        this.toolInput = null;
        this.toolProgress = null;
        // The AskUserQuestion tool call is over — drop its group list so a later
        // prompt (a `/model` picker, the next question) can't inherit stale
        // groups when it computes multiSelect or the submit distance.
        this.askGroups = [];
        this.activeGroupIndex = 0;
        this.emitSnapshot();
        break;
      }

      case 'Stop':
        this.currentTool = null;
        this.toolInput = null;
        this.toolProgress = null;
        this.options = [];
        this.question = null;
        this.navigable = false;
        this.cursorIndex = 0;
        this.askGroups = [];
        this.activeGroupIndex = 0;
        this.transition(State.IDLE, 'stop', 'hook');
        break;

      case 'SessionEnd':
        this.modelName = null;
        this.effortLevel = null;
        this.billingType = 'unknown';
        this.transition(State.DISCONNECTED, 'session_end', 'hook');
        break;

      case 'Notification': {
        if (typeof data.input_tokens === 'number' && typeof data.output_tokens === 'number') {
          this.usageTracker.addTokens(
            data.input_tokens as number,
            data.output_tokens as number,
          );
        }
        break;
      }

      // ── Codex CLI lifecycle hooks ──
      // Installed by hooks/src/codex-install.ts into ~/.codex/config.toml.
      // Mirrors Claude semantics so the same downstream display/eval logic
      // reacts to either. Schema source: Codex CLI hook payload (stdin JSON).
      case 'codex_session_start':
        // Reuse Claude trigger labels: the state-transition contract
        // (DISCONNECTED|IDLE → IDLE for session_start, IDLE → PROCESSING
        // for user_prompt_submit) is identical, so the transitions table
        // in shared/src/states.ts doesn't need codex_*-prefixed entries.
        this.usageTracker.start();
        this.transition(State.IDLE, 'session_start', 'hook');
        break;

      case 'codex_user_prompt_submit':
        this.suggestedPrompt = null;
        this.lastValidSuggestedPrompt = null;
        this.transition(State.PROCESSING, 'user_prompt_submit', 'hook');
        break;

      case 'codex_tool_start': {
        const toolName = (data.tool_name as string) || null;
        const toolInputData = data.tool_input as Record<string, unknown> | undefined;
        this.currentTool = toolName;
        this.toolInput = formatToolInput(toolName, toolInputData);
        this.toolProgress = toolName ? `Using ${toolName}` : null;
        this.emitSnapshot();
        break;
      }

      case 'codex_tool_end': {
        this.usageTracker.addToolCall(data);
        this.currentTool = null;
        this.toolInput = null;
        this.toolProgress = null;
        this.emitSnapshot();
        break;
      }

      case 'codex_stop':
        this.currentTool = null;
        this.toolInput = null;
        this.toolProgress = null;
        this.options = [];
        this.question = null;
        this.navigable = false;
        this.cursorIndex = 0;
        this.transition(State.IDLE, 'stop', 'hook');
        break;

      case 'codex_turn_complete':
        // Notify-fallback turn-completion ping. State already at IDLE via
        // codex_stop in the normal path; this is a best-effort signal for
        // metric counters when stop hook doesn't fire (rare).
        this.emitSnapshot();
        break;

      default:
        break;
    }
  }

  handleParserEvent(eventName: string, data?: Record<string, unknown>): void {
    debug('SM', `parserEvent: ${eventName} (current: ${this.state})`);
    switch (eventName) {
      case 'permission_prompt': {
        this.options = (data?.options as PromptOption[]) || [];
        this.question = (data?.question as string) || null;
        this.navigable = (data?.navigable as boolean) ?? false;
        this.cursorIndex = (data?.cursorIndex as number) ?? 0;
        this.transition(State.AWAITING_PERMISSION, 'permission_prompt', 'pty');
        break;
      }

      case 'option_prompt': {
        this.options = (data?.options as PromptOption[]) || [];
        this.question = (data?.question as string) || null;
        this.parsedMultiSelect = (data?.multiSelect as boolean) === true;
        this.navigable = (data?.navigable as boolean) ?? false;
        this.cursorIndex = (data?.cursorIndex as number) ?? 0;
        // Multi-group AskUserQuestion: the parser detects the prompt but can't
        // cleanly isolate each group's options from the accumulating TUI buffer,
        // so overwrite the scraped list with the authoritative group from the
        // hook. Cursor stays device-driven (see updateCursorIndex), so a
        // same-group re-emit here doesn't reset the user's position.
        if (this.askGroups.length > 1) this.applyActiveGroupOptions();
        if (this.state === State.AWAITING_OPTION) {
          // Already in AWAITING_OPTION — just update options and re-emit snapshot
          // (debounced chunks may re-parse with more complete data)
          debug('SM', `option_prompt update: ${this.options.length} options, nav=${this.navigable}, cursor=${this.cursorIndex}`);
          this.emitSnapshot();
        } else {
          this.transition(State.AWAITING_OPTION, 'option_ui_detected', 'pty');
        }
        break;
      }

      case 'diff_prompt': {
        this.options = (data?.options as PromptOption[]) || [];
        this.transition(State.AWAITING_DIFF, 'diff_ui_detected', 'pty');
        break;
      }

      case 'suggested_prompt': {
        this.suggestedPrompt = (data?.text as string) ?? null;
        if (this.suggestedPrompt) {
          this.lastValidSuggestedPrompt = this.suggestedPrompt;
        }
        this.emitSnapshot();
        break;
      }

      case 'spinner_start':
        this.suggestedPrompt = null;
        if (this.state !== State.PROCESSING) {
          // Clean up awaiting state data if recovering from a prompt
          if (
            this.state === State.AWAITING_OPTION ||
            this.state === State.AWAITING_PERMISSION ||
            this.state === State.AWAITING_DIFF
          ) {
            this.options = [];
            this.question = null;
            this.navigable = false;
            this.cursorIndex = 0;
            this.toolInput = null;
          }
          this.transition(State.PROCESSING, 'spinner_start', 'pty');
        }
        break;

      case 'spinner_stop':
        // Spinner stopped — if we're in an active state, go to IDLE
        if (
          this.state === State.PROCESSING ||
          this.state === State.AWAITING_PERMISSION ||
          this.state === State.AWAITING_OPTION ||
          this.state === State.AWAITING_DIFF
        ) {
          this.currentTool = null;
          this.toolInput = null;
          this.toolProgress = null;
          this.options = [];
          this.question = null;
          this.navigable = false;
          this.cursorIndex = 0;
          this.transition(State.IDLE, 'idle_detected', 'pty');
        }
        break;

      case 'idle':
        if (
          this.state === State.PROCESSING ||
          this.state === State.AWAITING_PERMISSION ||
          this.state === State.AWAITING_OPTION ||
          this.state === State.AWAITING_DIFF
        ) {
          this.currentTool = null;
          this.toolInput = null;
          this.toolProgress = null;
          this.options = [];
          this.question = null;
          this.navigable = false;
          this.cursorIndex = 0;
          this.transition(State.IDLE, 'idle_detected', 'pty');
        }
        break;

      case 'mode_change': {
        const mode = data?.mode as string | undefined;
        if (mode === 'plan') {
          this.setPermissionMode(PermissionMode.PLAN);
        } else if (mode === 'acceptEdits') {
          this.setPermissionMode(PermissionMode.ACCEPT_EDITS);
        } else {
          this.setPermissionMode(PermissionMode.DEFAULT);
        }
        break;
      }

      // --- Metadata events (don't change state, update display data) ---
      case 'status_line': {
        // Token/duration from PTY status line: "1m 0s · ↓ 1.9k tokens"
        const durationSec = data?.durationSec as number | undefined;
        const tokens = data?.tokens as number | undefined;
        if (durationSec != null) {
          this.usageTracker.setDuration(durationSec);
        }
        if (tokens != null) {
          this.usageTracker.setOutputTokens(tokens);
        }
        this.emitSnapshot();
        break;
      }

      case 'tool_action': {
        const toolName = data?.toolName as string | undefined;
        const toolArgs = data?.toolArgs as string | undefined;
        if (toolName) {
          this.currentTool = toolName;
          this.toolProgress = `Using ${toolName}`;
          // PTY args as fallback when hook data hasn't provided toolInput
          if (toolArgs && !this.toolInput) {
            this.toolInput = toolArgs;
          }
          this.usageTracker.incrementToolCalls();
          this.emitSnapshot();
        }
        break;
      }

      case 'project_name': {
        const name = data?.name as string | undefined;
        if (name) {
          this.projectName = name;
          debug('SM', `project: ${name}`);
          this.emitSnapshot();
        }
        break;
      }

      case 'model_info': {
        const model = data?.model as string | undefined;
        const plan = data?.plan as string | undefined;
        if (model) {
          this.modelName = model;
          debug('SM', `model: ${model}`);
        }
        if (plan) {
          if (/max/i.test(plan)) {
            this.billingType = 'subscription';
          } else if (/api/i.test(plan)) {
            this.billingType = 'api';
          }
          debug('SM', `billingType: ${this.billingType} (plan="${plan}")`);
        }
        if (model || plan) {
          this.emitSnapshot();
        }
        break;
      }

      case 'effort_level': {
        const level = data?.level as string | undefined;
        if (level) {
          this.effortLevel = level;
          debug('SM', `effortLevel: ${level}`);
          this.emitSnapshot();
        }
        break;
      }

      case 'remote_url': {
        const url = data?.url as string | undefined;
        if (url) {
          this.remoteUrl = url;
          debug('SM', `remoteUrl: ${url}`);
          this.emitSnapshot();
        }
        break;
      }

      default:
        break;
    }
  }

  /** Update billing type from external source (e.g., OAuth API response) if still unknown */
  inferBillingType(inferred: 'subscription' | 'api'): void {
    if (this.billingType === 'unknown') {
      this.billingType = inferred;
      debug('SM', `billingType inferred from API: ${inferred}`);
      this.emitSnapshot();
    }
  }

  handleUserAction(action: string): void {
    switch (action) {
      case 'respond':
        if (
          this.state === State.AWAITING_PERMISSION ||
          this.state === State.AWAITING_DIFF
        ) {
          this.options = [];
          this.question = null;
          this.navigable = false;
          this.cursorIndex = 0;
          this.toolInput = null;
          this.transition(State.PROCESSING, 'user_response', 'user');
        }
        break;

      case 'select_option':
        if (
          this.state === State.AWAITING_OPTION ||
          this.state === State.AWAITING_PERMISSION ||
          this.state === State.AWAITING_DIFF
        ) {
          this.options = [];
          this.question = null;
          this.navigable = false;
          this.cursorIndex = 0;
          this.toolInput = null;
          this.transition(State.PROCESSING, 'user_selection', 'user');
        }
        break;

      case 'send_prompt':
        if (this.state === State.IDLE) {
          this.suggestedPrompt = null;
          this.transition(State.PROCESSING, 'user_prompt_submit', 'hook');
        }
        break;

      case 'interrupt':
        this.currentTool = null;
        this.toolInput = null;
        this.toolProgress = null;
        this.options = [];
        this.question = null;
        this.navigable = false;
        this.cursorIndex = 0;
        this.transition(State.IDLE, 'interrupt', 'user');
        break;

      default:
        break;
    }
  }

  transition(to: State, trigger: string, source: string): void {
    const valid = transitions.some(
      (t: StateTransition) =>
        (t.from === this.state || t.from === '*') &&
        t.to === to &&
        t.trigger === trigger,
    );

    if (!valid) {
      debug('SM', `Invalid transition blocked: ${this.state} -> ${to} (trigger: ${trigger}, source: ${source})`);
      return;
    }

    const prev = this.state;
    this.state = to;

    // Reset cursor authority when leaving AWAITING states
    if (
      prev === State.AWAITING_OPTION ||
      prev === State.AWAITING_PERMISSION ||
      prev === State.AWAITING_DIFF
    ) {
      this.cursorAuthority = 'pty';
    }

    // Manage stuck-state timer. PROCESSING recovers after STUCK_TIMEOUT_MS
    // (Claude seems hung). AWAITING_* get NO wall-clock backstop: an unanswered
    // permission/option/diff prompt is a genuine, indefinitely-valid wait — the
    // user may be away for hours. A blind timer can't tell "away" from "parser
    // missed the recovery", so it wrongly forced a real prompt to IDLE and made
    // the session's creature vanish from the dashboard. Awaiting only leaves via
    // a real signal (spinner_start / idle_detected / user response / stop), and
    // a truly-dead session is reaped by liveness (PID death / /health grace),
    // not by this timer.
    this.resetStuckTimer();
    if (to === State.PROCESSING) {
      this.armStuckTimer(STUCK_TIMEOUT_MS);
    }

    if (prev !== to) {
      debug('SM', `${prev} -> ${to} (trigger: ${trigger}, source: ${source})`);
      this.emitSnapshot();
    }
  }

  /** Reset the stuck timer on PTY activity. Only PROCESSING carries a hang
   *  timeout; AWAITING_* has no wall-clock backstop (see transition()), so there
   *  is nothing to re-arm for those states. */
  onPtyActivity(): void {
    if (!this.stuckTimer) return;
    if (this.state === State.PROCESSING) {
      debug('SM', 'PTY activity — resetting PROCESSING stuck timer');
      this.armStuckTimer(STUCK_TIMEOUT_MS);
    }
  }

  /** (Re)arm the stuck-state backstop. On fire, clears tool/prompt metadata and
   *  recovers to IDLE — the safe terminal state for any hung/abandoned state. */
  private armStuckTimer(timeoutMs: number): void {
    this.resetStuckTimer();
    const fromState = this.state;
    this.stuckTimer = setTimeout(() => {
      debug('SM', `Stuck timeout: ${fromState} for >${timeoutMs / 1000}s, recovering to IDLE`);
      this.currentTool = null;
      this.toolInput = null;
      this.toolProgress = null;
      this.options = [];
      this.question = null;
      this.navigable = false;
      this.cursorIndex = 0;
      this.transition(State.IDLE, 'stuck_timeout', 'internal');
    }, timeoutMs);
  }

  private resetStuckTimer(): void {
    if (this.stuckTimer) {
      clearTimeout(this.stuckTimer);
      this.stuckTimer = null;
    }
  }

  private emitSnapshot(): void {
    this.emit('state_changed', this.getSnapshot());
  }

  /** Overwrite the surfaced option list with the active group's authoritative
   *  options from the hook. Preserves the cursor (device-driven) but clamps it,
   *  so a same-group re-emit doesn't move the user's position. */
  private applyActiveGroupOptions(): void {
    const g = this.askGroups[this.activeGroupIndex];
    if (!g) return;
    this.options = g.options;
    this.question = g.question;
    this.parsedMultiSelect = g.multiSelect;
    this.navigable = true;
    if (this.cursorIndex >= g.options.length) {
      this.cursorIndex = Math.max(0, g.options.length - 1);
    }
  }

  /**
   * Advance a multi-group AskUserQuestion to the next group and surface it.
   *
   * Called when the device answers a NON-final group: the bridge has already
   * sent one `→` to move the TUI onto the next tab, and this puts the matching
   * group on the deck from hook data — immediately, without waiting for (or
   * trusting) the parser to re-scrape the switched tab. Cursor resets to the top
   * of the new group. No-op on the last group (the caller submits instead).
   */
  advanceToNextGroup(): void {
    if (this.activeGroupIndex + 1 >= this.askGroups.length) return;
    this.activeGroupIndex++;
    this.cursorIndex = 0;
    this.cursorAuthority = 'optimistic';
    this.applyActiveGroupOptions();
    debug('SM', `advanced to group ${this.activeGroupIndex + 1}/${this.askGroups.length}: "${this.question}" (${this.options.length} options)`);
    this.emitSnapshot();
  }

  /** Update cursor index with source discrimination to prevent race conditions.
   *  'optimistic' — from StreamDeck dial navigation (immediate, may be overridden by PTY)
   *  'pty' — from parser cursor_update (authoritative, but may be stale during rapid navigation)
   */
  updateCursorIndex(idx: number, source: 'pty' | 'optimistic' = 'pty'): void {
    // A multi-group prompt's option list is bridge-driven from hook data, so the
    // parser's scraped cursor points into the stale first-group rows it latched
    // in the shared buffer. Device navigation (optimistic) is the only reliable
    // cursor there — drop the PTY confirmation rather than let it jump the row.
    if (source === 'pty' && this.askGroups.length > 1) return;
    if (source === 'optimistic') {
      this.cursorIndex = idx;
      this.cursorAuthority = 'optimistic';
      this.optimisticCursorTime = Date.now();
      this.emitSnapshot();
    } else {
      // PTY confirmation: always accept unless very recent optimistic update
      const elapsed = Date.now() - this.optimisticCursorTime;
      if (this.cursorAuthority === 'pty' || elapsed > 200) {
        this.cursorIndex = idx;
        this.cursorAuthority = 'pty';
        this.emitSnapshot();
      }
      // else: suppress stale PTY value (optimistic update is fresher)
    }
  }

  /**
   * Does the question currently on screen accept several answers?
   *
   * Resolved on read rather than stored: `question` is cleared from eleven
   * places, and a cached flag would survive whichever one forgot to clear it —
   * which on this surface means a device offering checkboxes for a single-
   * choice prompt and answering it with the wrong keystrokes.
   *
   * Matched by prefix in both directions because the two strings come from
   * different places: the parser reads the question off a width-constrained TUI
   * (truncated, whitespace-collapsed) while the map holds the tool input's own
   * text. Same tolerance as the ask-gate's `askEchoMatches`.
   */
  private resolveMultiSelect(): boolean {
    if (this.state !== State.AWAITING_OPTION) return false;
    if (this.parsedMultiSelect) return true;
    const shown = normalizeQuestion(this.question);
    if (!shown) return false;
    const hit = this.askGroups.find(({ question }) => {
      const known = normalizeQuestion(question);
      if (!known) return false;
      return known === shown || known.startsWith(shown) || shown.startsWith(known);
    });
    return hit?.multiSelect === true;
  }

  /**
   * Arrow-RIGHT presses that take the prompt from the question tab on screen to
   * the trailing `Submit` tab, or null when that cannot be established.
   *
   * An AskUserQuestion renders as a tab strip — `← ☒ 作業内容 ✔ Submit →` — and
   * `Submit` is always the last tab. Landing on it opens a review screen whose
   * cursor already sits on "Submit answers", so `→`×N then Enter commits the
   * whole answer set.
   *
   * The count comes from the tool input's group list plus the bridge-tracked
   * active-group index, never from the screen. Every screen-derived measurement
   * on this surface has failed the same way: Claude Code repaints only what
   * changed, so a frame routinely carries a partial option list (measured live:
   * four rows for a six-row prompt), and a walk sized from it stops short and
   * drops its Enter on an option row — which TOGGLES, un-ticking the answer and
   * committing nothing. Which group is on screen is likewise not read off the
   * TUI (the parser can't place a later group's truncated question) but tracked
   * as the device advances through them.
   */
  getSubmitTabDistance(): number | null {
    if (this.state !== State.AWAITING_OPTION) {
      debug('SM', `submitTab: not awaiting (state=${this.state})`);
      return null;
    }
    if (this.askGroups.length === 0) {
      // The hook input that carries the question-group list never arrived (or was
      // cleared) — but the parser saw a checkbox list on the TUI, so this IS a
      // multi-select. A single-question AskUserQuestion (the overwhelming common
      // case) puts `Submit` exactly one tab right of the question, so fall back
      // to that rather than skipping the submit and stranding the ticks on
      // screen with nothing committed.
      if (this.parsedMultiSelect) {
        debug('SM', 'submitTab: no hook groups but parser saw a checkbox list → single-question fallback (tabs=1)');
        return 1;
      }
      debug('SM', 'submitTab: no AskUserQuestion groups recorded');
      return null;
    }
    // Submit is the last tab, so from the active group it is (groups after this
    // one) + 1 away. `activeGroupIndex` is authoritative — it advances only when
    // the device answers a group — so this needs no fragile question read and is
    // 1 for a single-group prompt and for the final group of a multi-group one.
    const idx = Math.min(this.activeGroupIndex, this.askGroups.length - 1);
    return this.askGroups.length - idx;
  }

  getCursorIndex(): number {
    return this.cursorIndex;
  }

  getOptionsCount(): number {
    return this.options.length;
  }

  getSnapshot(): StateSnapshot {
    const usage = this.usageTracker.getSnapshot();
    return {
      state: this.state,
      permissionMode: this.permissionMode,
      currentTool: this.currentTool,
      toolInput: this.toolInput,
      toolProgress: this.toolProgress,
      options: this.options,
      question: this.question,
      multiSelect: this.resolveMultiSelect(),
      navigable: this.navigable,
      cursorIndex: this.cursorIndex,
      projectName: this.projectName,
      modelName: this.modelName,
      effortLevel: this.effortLevel,
      billingType: this.billingType,
      sessionDurationSec: usage.sessionDurationSec,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      toolCalls: usage.toolCalls,
      estimatedCostUsd: usage.estimatedCostUsd,
      sessionPercent: usage.sessionPercent,
      costSpent: usage.costSpent,
      costLimit: usage.costLimit,
      resetTime: usage.resetTime,
      resetDate: usage.resetDate,
      suggestedPrompt: this.suggestedPrompt,
      remoteUrl: this.remoteUrl,
    };
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.emitSnapshot();
  }

  getState(): State {
    return this.state;
  }

  /** Get last valid suggested prompt (for reconnection recovery when suggestedPrompt is already null) */
  getLastValidSuggestedPrompt(): string | null {
    return this.lastValidSuggestedPrompt;
  }
}

/** Collapse a question to a comparable form: the parser and the tool input
 *  disagree on whitespace, and the TUI copy may be truncated. */
function normalizeQuestion(q: string | null | undefined): string {
  return typeof q === 'string' ? q.replace(/\s+/g, ' ').trim() : '';
}

/** One question group of an AskUserQuestion, carrying its own option list. */
export interface AskGroup {
  question: string;
  multiSelect: boolean;
  /** The group's options, in tool-input order (= on-screen row order). */
  options: PromptOption[];
}

/**
 * Pull the question groups out of an AskUserQuestion tool input.
 *
 * Shape is `{ questions: [{ question, header, options, multiSelect }] }`; every
 * field is treated as untrusted, since this arrives as a hook payload. Anything
 * unparseable yields an empty list, which resolves to "single-select" — the
 * safe default, because offering checkboxes for a single-choice prompt sends
 * keystrokes the TUI will not accept.
 *
 * The per-group `options` are kept (not just `multiSelect`) because a
 * multi-QUESTION prompt can't be scraped group-by-group off the TUI: the buffer
 * accumulates every group's rows and later groups draw their labels via ANSI
 * column positioning, so the parser latches the first group's stale rows. The
 * hook payload is the authoritative, un-truncated source, and later groups are
 * surfaced to the device from it (see `advanceToNextGroup`).
 */
export function collectAskGroups(
  toolInput: Record<string, unknown> | undefined,
): AskGroup[] {
  const raw = toolInput?.questions;
  if (!Array.isArray(raw)) return [];
  const out: AskGroup[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const q = e.question;
    if (typeof q !== 'string' || !q.trim()) continue;
    const options: PromptOption[] = [];
    if (Array.isArray(e.options)) {
      for (const opt of e.options) {
        // An option is either a bare string or `{ label, description }`.
        const label = typeof opt === 'string'
          ? opt
          : (opt && typeof opt === 'object' && typeof (opt as Record<string, unknown>).label === 'string'
            ? (opt as Record<string, unknown>).label as string
            : null);
        if (label && label.trim()) options.push({ index: options.length, label });
      }
    }
    out.push({ question: q, multiSelect: e.multiSelect === true, options });
  }
  return out;
}

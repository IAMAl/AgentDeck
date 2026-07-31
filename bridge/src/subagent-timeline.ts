import {
  extractTopicHintWithKind,
  promptSnippetFallback,
  stripUnsafeText,
  type TimelineEntry,
} from '@agentdeck/shared';

export interface SubagentTimelineHook {
  eventName: string;
  payload: Record<string, unknown>;
  sessionId: string;
  agentType: string;
  projectName?: string;
}

export interface SubagentTimelineResult {
  /**
   * The hook belongs to a child agent/team lifecycle and must not enter the
   * parent session's state, approval, steering, or APME pipelines.
   */
  childOnly: boolean;
}

type TimelineEmitter = (entry: TimelineEntry) => void;

interface ActiveSubagent {
  startedAt: number;
  label: string;
}

const ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = stripUnsafeText(value)
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function cap(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trim()}…` : value;
}

function normalizedEventName(eventName: string): string {
  switch (eventName) {
    case 'SubagentStart':
    case 'codex_subagent_start':
      return 'subagent_start';
    case 'SubagentStop':
    case 'codex_subagent_stop':
      return 'subagent_stop';
    case 'TaskCompleted':
      return 'task_completed';
    case 'TeammateIdle':
      return 'teammate_idle';
    default:
      return eventName;
  }
}

export function isSubagentOnlyHook(
  eventName: string,
  payload: Record<string, unknown>,
): boolean {
  const event = normalizedEventName(eventName);
  if (
    event === 'subagent_start' || event === 'subagent_stop'
    || event === 'task_completed' || event === 'teammate_idle'
  ) {
    return true;
  }
  // Claude/Codex reserve agent_id for child-agent context. Consume every
  // such hook, including future Notification/Stop variants, so child
  // lifecycle can never drift into parent steering or turn state.
  return nonEmptyString(payload.agent_id) !== null;
}

function agentLabel(payload: Record<string, unknown>): string {
  const raw = nonEmptyString(payload.agent_type)
    ?? nonEmptyString(payload.teammate_name)
    ?? 'Subagent';
  return cap(raw.replace(/^general-purpose$/i, 'General'), 28);
}

function completionSummary(payload: Record<string, unknown>): {
  text: string;
  summaryKind: 'heuristic' | 'none';
} {
  const response = nonEmptyString(payload.last_assistant_message)
    ?? nonEmptyString(payload.task_subject)
    ?? nonEmptyString(payload.task_description);
  if (response) {
    const hint = extractTopicHintWithKind(response);
    if (hint.hint) {
      return {
        text: cap(hint.hint, 96),
        summaryKind: hint.kind === 'topic' ? 'heuristic' : 'none',
      };
    }
    const fallback = promptSnippetFallback(response, 96);
    if (fallback) return { text: fallback, summaryKind: 'none' };
  }
  return { text: 'Completed', summaryKind: 'none' };
}

/**
 * Read-only lifecycle reducer for Claude Code/Codex child agents.
 *
 * It intentionally emits only existing Timeline row types. This keeps old
 * macOS/iOS/Android/Node/ESP32 clients compatible and prevents child activity
 * from appearing as a controllable SessionInfo entry.
 */
export class SubagentTimelineTracker {
  private readonly active = new Map<string, ActiveSubagent>();

  constructor(
    private readonly emit: TimelineEmitter,
    private readonly now: () => number = Date.now,
  ) {}

  handle(hook: SubagentTimelineHook): SubagentTimelineResult {
    const event = normalizedEventName(hook.eventName);
    const agentId = nonEmptyString(hook.payload.agent_id);
    const childOnly = isSubagentOnlyHook(hook.eventName, hook.payload);

    this.sweep();

    if (event === 'subagent_start') {
      const id = agentId ?? nonEmptyString(hook.payload.task_id) ?? `anonymous:${this.now()}`;
      const key = `${hook.sessionId}:${id}`;
      const startedAt = this.now();
      const label = agentLabel(hook.payload);
      this.active.set(key, { startedAt, label });
      this.emit({
        ts: startedAt,
        type: 'tool_exec',
        raw: `Subagent ${label} · Started`,
        sessionId: hook.sessionId,
        agentType: hook.agentType,
        projectName: hook.projectName,
        startedAt,
        summaryKind: 'progress',
      });
      return { childOnly: true };
    }

    if (event === 'subagent_stop') {
      const id = agentId ?? nonEmptyString(hook.payload.task_id) ?? '';
      const key = `${hook.sessionId}:${id}`;
      const active = this.active.get(key);
      if (active) this.active.delete(key);
      const endedAt = this.now();
      const label = active?.label ?? agentLabel(hook.payload);
      const summary = completionSummary(hook.payload);
      this.emit({
        ts: endedAt,
        type: 'tool_resolved',
        raw: `Subagent ${label} · ${summary.text}`,
        sessionId: hook.sessionId,
        agentType: hook.agentType,
        projectName: hook.projectName,
        startedAt: active?.startedAt,
        endedAt,
        summaryKind: summary.summaryKind,
      });
      return { childOnly: true };
    }

    if (event === 'task_completed') {
      const endedAt = this.now();
      const label = agentLabel(hook.payload);
      const summary = completionSummary(hook.payload);
      this.emit({
        ts: endedAt,
        type: 'tool_resolved',
        raw: `Team ${label} · ${summary.text}`,
        sessionId: hook.sessionId,
        agentType: hook.agentType,
        projectName: hook.projectName,
        endedAt,
        summaryKind: summary.summaryKind,
      });
      return { childOnly: true };
    }

    // Idle is lifecycle metadata, not a useful Timeline row. Consume it so it
    // cannot alter the parent state while respecting the user's team setup.
    if (event === 'teammate_idle' || childOnly) {
      return { childOnly: true };
    }

    return { childOnly: false };
  }

  private sweep(): void {
    const cutoff = this.now() - ACTIVE_TTL_MS;
    for (const [key, value] of this.active) {
      if (value.startedAt < cutoff) this.active.delete(key);
    }
  }
}

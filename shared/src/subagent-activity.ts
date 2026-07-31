import type { TimelineEntry } from './timeline.js';

export interface SubagentVisualActivity {
  activeCount: number;
  lastCompletedAt?: number;
}

export type SubagentActivityBySession = Record<string, SubagentVisualActivity>;

export interface SubagentActivityOptions {
  now?: number;
  activeTtlMs?: number;
}

const DEFAULT_ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;

interface ActiveStart {
  ts: number;
  startedAt?: number;
}

/**
 * Derive the decorative parent/child activity shown by terrarium renderers.
 *
 * The result is intentionally computed from existing timeline rows, so older
 * clients can continue to ignore subagent visuals without a protocol or
 * session-schema change.
 */
export function deriveSubagentActivity(
  entries: readonly TimelineEntry[],
  options: SubagentActivityOptions = {},
): SubagentActivityBySession {
  const now = options.now ?? Date.now();
  const activeTtlMs = options.activeTtlMs ?? DEFAULT_ACTIVE_TTL_MS;
  const activeBySession = new Map<string, ActiveStart[]>();
  const completedBySession = new Map<string, number>();

  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.ts - b.entry.ts || a.index - b.index);

  for (const { entry } of ordered) {
    const sessionId = entry.sessionId?.trim();
    if (!sessionId) continue;

    const isSubagent = entry.raw.startsWith('Subagent ');
    const isTeamCompletion = entry.raw.startsWith('Team ');

    if (entry.type === 'tool_exec' && isSubagent) {
      const active = activeBySession.get(sessionId) ?? [];
      active.push({ ts: entry.ts, startedAt: entry.startedAt });
      activeBySession.set(sessionId, active);
      continue;
    }

    if (entry.type !== 'tool_resolved' || (!isSubagent && !isTeamCompletion)) {
      continue;
    }

    completedBySession.set(
      sessionId,
      Math.max(completedBySession.get(sessionId) ?? 0, entry.endedAt ?? entry.ts),
    );

    if (!isSubagent) continue;
    const active = activeBySession.get(sessionId);
    if (!active?.length) continue;

    const matchingIndex = entry.startedAt == null
      ? 0
      : active.findIndex((start) => start.startedAt === entry.startedAt);
    active.splice(matchingIndex >= 0 ? matchingIndex : 0, 1);
  }

  const result: SubagentActivityBySession = {};
  const sessionIds = new Set([
    ...activeBySession.keys(),
    ...completedBySession.keys(),
  ]);

  for (const sessionId of sessionIds) {
    const activeCount = (activeBySession.get(sessionId) ?? [])
      .filter((start) => now - start.ts <= activeTtlMs)
      .length;
    const lastCompletedAt = completedBySession.get(sessionId);
    if (activeCount === 0 && lastCompletedAt == null) continue;
    result[sessionId] = {
      activeCount,
      ...(lastCompletedAt == null ? {} : { lastCompletedAt }),
    };
  }

  return result;
}

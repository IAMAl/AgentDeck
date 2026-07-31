import { describe, expect, it } from 'vitest';
import type { TimelineEntry } from '../timeline.js';
import { deriveSubagentActivity } from '../subagent-activity.js';

function row(
  ts: number,
  type: TimelineEntry['type'],
  raw: string,
  sessionId = 'parent-1',
  startedAt?: number,
): TimelineEntry {
  return { ts, type, raw, sessionId, startedAt };
}

describe('deriveSubagentActivity', () => {
  it('pairs summarized starts and completions under their parent session', () => {
    const activity = deriveSubagentActivity([
      row(100, 'tool_exec', 'Subagent reviewer · Started', 'parent-1', 100),
      row(110, 'tool_exec', 'Subagent tester · Started', 'parent-1', 110),
      row(120, 'tool_resolved', 'Subagent reviewer · Review complete', 'parent-1', 100),
      row(130, 'tool_exec', 'Subagent docs · Started', 'parent-2', 130),
    ], { now: 150 });

    expect(activity).toEqual({
      'parent-1': { activeCount: 1, lastCompletedAt: 120 },
      'parent-2': { activeCount: 1 },
    });
  });

  it('uses team completion rows only as a recent completion pulse', () => {
    const activity = deriveSubagentActivity([
      row(200, 'tool_resolved', 'Team api · Finished compatibility audit'),
    ], { now: 220 });

    expect(activity['parent-1']).toEqual({
      activeCount: 0,
      lastCompletedAt: 200,
    });
  });

  it('ignores ordinary tools and expires orphaned starts', () => {
    const activity = deriveSubagentActivity([
      row(10, 'tool_exec', 'Bash · pnpm test'),
      row(20, 'tool_exec', 'Subagent stale · Started'),
    ], { now: 1_000, activeTtlMs: 100 });

    expect(activity).toEqual({});
  });

  it('sorts history rows before pairing them', () => {
    const activity = deriveSubagentActivity([
      row(400, 'tool_resolved', 'Subagent tester · Done', 'parent-1', 300),
      row(300, 'tool_exec', 'Subagent tester · Started', 'parent-1', 300),
    ], { now: 450 });

    expect(activity['parent-1']).toEqual({
      activeCount: 0,
      lastCompletedAt: 400,
    });
  });
});

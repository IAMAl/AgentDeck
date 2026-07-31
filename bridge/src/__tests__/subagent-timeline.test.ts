import { describe, expect, it } from 'vitest';
import type { TimelineEntry } from '@agentdeck/shared';
import { isSubagentOnlyHook, SubagentTimelineTracker } from '../subagent-timeline.js';

describe('SubagentTimelineTracker', () => {
  it('collapses start and stop into existing compatible Timeline types', () => {
    const entries: TimelineEntry[] = [];
    let now = 1_000;
    const tracker = new SubagentTimelineTracker((entry) => entries.push(entry), () => now);

    expect(tracker.handle({
      eventName: 'SubagentStart',
      payload: { agent_id: 'child-1', agent_type: 'Explore' },
      sessionId: 'parent-1',
      agentType: 'claude-code',
      projectName: 'AgentDeck',
    }).childOnly).toBe(true);

    now = 4_000;
    expect(tracker.handle({
      eventName: 'SubagentStop',
      payload: {
        agent_id: 'child-1',
        agent_type: 'Explore',
        last_assistant_message: '인증 흐름에서 경쟁 조건 2건을 확인했습니다.',
      },
      sessionId: 'parent-1',
      agentType: 'claude-code',
      projectName: 'AgentDeck',
    }).childOnly).toBe(true);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      type: 'tool_exec',
      raw: 'Subagent Explore · Started',
      sessionId: 'parent-1',
      summaryKind: 'progress',
    });
    expect(entries[1]).toMatchObject({
      type: 'tool_resolved',
      raw: 'Subagent Explore · 인증 흐름에서 경쟁 조건 2건을 확인했습니다.',
      sessionId: 'parent-1',
      startedAt: 1_000,
      endedAt: 4_000,
      summaryKind: 'heuristic',
    });
  });

  it('consumes child tool hooks without producing per-tool noise or controls', () => {
    const entries: TimelineEntry[] = [];
    const tracker = new SubagentTimelineTracker((entry) => entries.push(entry));
    const payload = {
      session_id: 'parent-1',
      agent_id: 'child-1',
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
    };

    expect(isSubagentOnlyHook('PreToolUse', payload)).toBe(true);
    expect(tracker.handle({
      eventName: 'PreToolUse',
      payload,
      sessionId: 'parent-1',
      agentType: 'claude-code',
    }).childOnly).toBe(true);
    expect(entries).toEqual([]);
  });

  it('keeps future child notification and stop hooks out of parent control', () => {
    const payload = { session_id: 'parent-1', agent_id: 'child-1' };
    expect(isSubagentOnlyHook('Notification', payload)).toBe(true);
    expect(isSubagentOnlyHook('Stop', payload)).toBe(true);
  });

  it('summarizes team task completion without exposing team settings', () => {
    const entries: TimelineEntry[] = [];
    const tracker = new SubagentTimelineTracker((entry) => entries.push(entry), () => 9_000);

    tracker.handle({
      eventName: 'TaskCompleted',
      payload: {
        teammate_name: 'reviewer',
        task_subject: '릴리스 호환성 검토 완료',
      },
      sessionId: 'parent-1',
      agentType: 'claude-code',
    });

    expect(entries).toEqual([
      expect.objectContaining({
        type: 'tool_resolved',
        raw: 'Team reviewer · 릴리스 호환성 검토 완료',
      }),
    ]);
  });

  it('recognizes Codex lifecycle names and preserves the provider', () => {
    const entries: TimelineEntry[] = [];
    const tracker = new SubagentTimelineTracker((entry) => entries.push(entry), () => 5_000);

    tracker.handle({
      eventName: 'codex_subagent_stop',
      payload: {
        agent_id: 'agent-2',
        agent_type: 'reviewer',
        last_assistant_message: 'No compatibility regressions found.',
      },
      sessionId: 'thread-1',
      agentType: 'codex-cli',
    });

    expect(entries[0]).toMatchObject({
      type: 'tool_resolved',
      agentType: 'codex-cli',
      raw: 'Subagent reviewer · No compatibility regressions found.',
    });
  });
});

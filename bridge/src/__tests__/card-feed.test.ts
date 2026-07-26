import { describe, it, expect, vi } from 'vitest';
import {
  classifySessionCard,
  buildCardFeed,
  applyOutboxDecisions,
  PERMISSION_GATE_TTL_MS,
  AWAITING_PROMPT_TTL_MS,
  type OutboxApplyDeps,
} from '../card-feed.js';
import type { SessionInfo, OutboxDecision } from '@agentdeck/shared';
import { CARD_FEED_IDLE_PULL_SEC, CARD_FEED_ACTIVE_PULL_SEC } from '@agentdeck/shared';

const NOW = 1_750_000_000_000;

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'observed:claude:abc',
    port: 0,
    projectName: 'AgentDeck',
    alive: true,
    state: 'idle',
    ...over,
  } as SessionInfo;
}

describe('classifySessionCard', () => {
  it('permission gate → live with the long-poll TTL', () => {
    const c = classifySessionCard(session({ requestId: 'req-1', state: 'awaiting_permission' }), NOW);
    expect(c.actionClass).toBe('live');
    expect(c.expiresAt).toBe(NOW + PERMISSION_GATE_TTL_MS);
  });

  it('awaiting prompt without requestId → live with the awaiting backstop TTL', () => {
    const c = classifySessionCard(session({ state: 'awaiting_option', question: 'Pick one' }), NOW);
    expect(c.actionClass).toBe('live');
    expect(c.expiresAt).toBe(NOW + AWAITING_PROMPT_TTL_MS);
  });

  it('idle/processing sessions → info without expiry', () => {
    expect(classifySessionCard(session({ state: 'idle' }), NOW)).toEqual({ actionClass: 'info' });
    expect(classifySessionCard(session({ state: 'processing' }), NOW)).toEqual({ actionClass: 'info' });
  });
});

describe('buildCardFeed', () => {
  it('derives one card per session with cardId session:<id>', () => {
    const feed = buildCardFeed([session({ id: 'a' }), session({ id: 'b', state: 'awaiting_option' })], NOW);
    expect(feed.type).toBe('card_feed');
    expect(feed.rev).toBe(1);
    expect(feed.serverTime).toBe(NOW);
    expect(feed.serverHm).toMatch(/^\d{2}:\d{2}$/);
    expect(feed.cards.map((c) => c.cardId)).toEqual(['session:a', 'session:b']);
    expect(feed.cards[1]!.actionClass).toBe('live');
    expect(feed.cards[0]!.session?.id).toBe('a');
  });

  it('pull cadence hint: idle roster → idle interval, active roster → active interval', () => {
    expect(buildCardFeed([session()], NOW).nextPullSec).toBe(CARD_FEED_IDLE_PULL_SEC);
    expect(buildCardFeed([session({ state: 'processing' })], NOW).nextPullSec).toBe(CARD_FEED_ACTIVE_PULL_SEC);
    expect(buildCardFeed([session({ state: 'awaiting_permission' })], NOW).nextPullSec).toBe(CARD_FEED_ACTIVE_PULL_SEC);
    expect(buildCardFeed([], NOW).nextPullSec).toBe(CARD_FEED_IDLE_PULL_SEC);
  });
});

function makeDeps(over: Partial<OutboxApplyDeps> = {}): OutboxApplyDeps & { dispatch: ReturnType<typeof vi.fn> } {
  return {
    sessions: [],
    isPendingRequest: () => false,
    dispatch: vi.fn(),
    now: NOW,
    ...over,
  } as OutboxApplyDeps & { dispatch: ReturnType<typeof vi.fn> };
}

const push = (decisions: OutboxDecision[], deps: OutboxApplyDeps) =>
  applyOutboxDecisions({ board: 'xteink_x4', decisions }, deps);

describe('applyOutboxDecisions', () => {
  it('dismiss is always acknowledged, never dispatched', () => {
    const deps = makeDeps();
    const res = push([{ cardId: 'session:a', action: 'dismiss' }], deps);
    expect(res.results).toEqual([{ cardId: 'session:a', status: 'applied' }]);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('permission_decision applies only while the gate is still pending', () => {
    const deps = makeDeps({ isPendingRequest: (id) => id === 'req-live' });
    const res = push([
      { cardId: 'session:a', action: 'permission_decision', requestId: 'req-live', decision: 'allow' },
      { cardId: 'session:b', action: 'permission_decision', requestId: 'req-dead', decision: 'deny' },
    ], deps);
    expect(res.results[0]!.status).toBe('applied');
    expect(res.results[1]!.status).toBe('expired');
    expect(deps.dispatch).toHaveBeenCalledOnce();
    expect(deps.dispatch).toHaveBeenCalledWith({ type: 'permission_decision', requestId: 'req-live', decision: 'allow' });
  });

  it('permission_decision without requestId/decision is rejected', () => {
    const deps = makeDeps();
    const res = push([{ cardId: 'session:a', action: 'permission_decision' }], deps);
    expect(res.results[0]!.status).toBe('rejected');
  });

  it('select_option routes session-scoped when the session is still awaiting', () => {
    const deps = makeDeps({ sessions: [session({ id: 'sid-1', state: 'awaiting_option', question: 'Pick one' })] });
    const res = push([{ cardId: 'session:sid-1', action: 'select_option', index: 2, question: 'Pick one' }], deps);
    expect(res.results[0]!.status).toBe('applied');
    expect(deps.dispatch).toHaveBeenCalledWith({ type: 'select_option', index: 2, sessionId: 'sid-1' });
  });

  it('select_option expires when the prompt question changed', () => {
    const deps = makeDeps({ sessions: [session({ id: 'sid-1', state: 'awaiting_option', question: 'NEW question' })] });
    const res = push([{ cardId: 'session:sid-1', action: 'select_option', index: 0, question: 'OLD question' }], deps);
    expect(res.results[0]!.status).toBe('expired');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('select_option expires when the session is no longer awaiting', () => {
    const deps = makeDeps({ sessions: [session({ id: 'sid-1', state: 'processing' })] });
    const res = push([{ cardId: 'session:sid-1', action: 'select_option', index: 0 }], deps);
    expect(res.results[0]!.status).toBe('expired');
  });

  it('unknown session → unknown_card', () => {
    const deps = makeDeps();
    const res = push([{ cardId: 'session:ghost', action: 'select_option', index: 0 }], deps);
    expect(res.results[0]!.status).toBe('unknown_card');
  });

  it('respond routes through session_command with the value', () => {
    const deps = makeDeps({ sessions: [session({ id: 'sid-1', state: 'awaiting_permission', question: 'Allow?' })] });
    const res = push([{ cardId: 'session:sid-1', action: 'respond', value: 'y' }], deps);
    expect(res.results[0]!.status).toBe('applied');
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: 'session_command', sessionId: 'sid-1', command: { type: 'respond', value: 'y' },
    });
  });

  it('send_prompt queues via session_command for any alive session', () => {
    const deps = makeDeps({ sessions: [session({ id: 'sid-1', state: 'processing' })] });
    const res = push([{ cardId: 'session:sid-1', action: 'send_prompt', text: 'run the tests' }], deps);
    expect(res.results[0]!.status).toBe('applied');
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: 'session_command', sessionId: 'sid-1', command: { type: 'send_prompt', text: 'run the tests' },
    });
  });

  it('malformed decisions are rejected without dispatch, order preserved', () => {
    const deps = makeDeps({ sessions: [session({ id: 'sid-1', state: 'awaiting_option' })] });
    const res = push([
      { cardId: '', action: 'select_option', index: 0 } as OutboxDecision,
      { cardId: 'session:sid-1', action: 'nonsense' } as unknown as OutboxDecision,
      { cardId: 'session:sid-1', action: 'select_option', index: -1 },
      { cardId: 'session:sid-1', action: 'select_option', index: 1 },
    ], deps);
    expect(res.results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'applied']);
    expect(deps.dispatch).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
  });

  it('empty/absent decisions array → ok with no results', () => {
    const res = applyOutboxDecisions({ decisions: [] }, makeDeps());
    expect(res).toEqual({ ok: true, results: [] });
  });
});

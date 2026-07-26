import { describe, it, expect, vi } from 'vitest';
import {
  classifySessionCard,
  buildCardFeed,
  applyOutboxDecisions,
  FeedPullTracker,
  formatFeedPull,
  normalizeClientIp,
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

describe('FeedPullTracker', () => {
  const IP = '::ffff:192.168.68.77';

  it('normalizes v4-mapped and loopback client addresses', () => {
    expect(normalizeClientIp('::ffff:192.168.68.77')).toBe('192.168.68.77');
    expect(normalizeClientIp('::1')).toBe('127.0.0.1');
    expect(normalizeClientIp('192.168.68.76')).toBe('192.168.68.76');
  });

  it('first pull carries no interval; the second measures it against the advertised cadence', () => {
    const t = new FeedPullTracker();
    const first = t.record(IP, { cards: 3, nextPullSec: 3600, now: NOW });
    expect(first.client).toBe('192.168.68.77');
    expect(first.sinceLastSec).toBeUndefined();
    expect(first.cadenceHonoured).toBeUndefined();

    // Woke 12s late off a drifty internal timer — still the cadence working.
    const second = t.record(IP, { cards: 2, nextPullSec: 3600, now: NOW + 3612_000 });
    expect(second.sinceLastSec).toBe(3612);
    expect(second.expectedSec).toBe(3600);
    expect(second.driftPct).toBeCloseTo(0.003, 3);
    expect(second.cadenceHonoured).toBe(true);
  });

  it('a gap far off the advertised cadence is not counted as honoured', () => {
    const t = new FeedPullTracker();
    t.record(IP, { cards: 0, nextPullSec: 3600, now: NOW });
    // Came back after 4 minutes: something woke it, but not the hourly timer.
    const early = t.record(IP, { cards: 0, nextPullSec: 3600, now: NOW + 240_000 });
    expect(early.cadenceHonoured).toBe(false);
    expect(early.driftPct).toBeCloseTo(-0.933, 3);
    expect(t.clients()[0]!.cadenceHonouredCount).toBe(0);
  });

  it('compares against the cadence advertised on the PREVIOUS pull, not the current one', () => {
    const t = new FeedPullTracker();
    // Sessions were active, so the daemon asked for a 900s cadence...
    t.record(IP, { cards: 1, nextPullSec: 900, now: NOW });
    // ...the device honoured that, and by now the roster went idle (3600s).
    const ev = t.record(IP, { cards: 1, nextPullSec: 3600, now: NOW + 900_000 });
    expect(ev.expectedSec).toBe(900);
    expect(ev.cadenceHonoured).toBe(true);
    expect(ev.nextPullSec).toBe(3600);
  });

  it('learns the board from an outbox push and keeps it for later anonymous pulls', () => {
    const t = new FeedPullTracker();
    const anon = t.record(IP, { cards: 1, nextPullSec: 3600, now: NOW });
    expect(anon.board).toBeUndefined();
    t.noteBoard(IP, 'xteink_x4');
    const named = t.record(IP, { cards: 1, nextPullSec: 3600, now: NOW + 3600_000 });
    expect(named.board).toBe('xteink_x4');
    expect(t.clients()[0]!.board).toBe('xteink_x4');
  });

  it('tracks clients independently and reports the median observed interval', () => {
    const t = new FeedPullTracker();
    t.noteBoard('192.168.68.76', 'xteink_x3');
    t.record('192.168.68.76', { cards: 0, nextPullSec: 3600, now: NOW });
    t.record(IP, { cards: 0, nextPullSec: 3600, now: NOW + 1000 });
    t.record('192.168.68.76', { cards: 0, nextPullSec: 3600, now: NOW + 3600_000 });
    t.record('192.168.68.76', { cards: 0, nextPullSec: 3600, now: NOW + 7300_000 });

    const clients = t.clients();
    expect(clients).toHaveLength(2);
    const x3 = clients.find((c) => c.board === 'xteink_x3')!;
    expect(x3.pulls).toBe(3);
    expect(x3.medianIntervalSec).toBe(3650);
    expect(x3.cadenceHonouredCount).toBe(2);
    // Newest-first ordering: the X3 pulled most recently.
    expect(clients[0]!.client).toBe('192.168.68.76');
  });

  it('bounds its history ring, newest first', () => {
    const t = new FeedPullTracker({ historyLimit: 3 });
    for (let i = 0; i < 5; i++) t.record(IP, { cards: i, nextPullSec: 3600, now: NOW + i * 1000 });
    const recent = t.recent();
    expect(recent).toHaveLength(3);
    expect(recent.map((e) => e.cards)).toEqual([4, 3, 2]);
  });

  it('formats the pull line with the drift verdict', () => {
    const t = new FeedPullTracker();
    t.noteBoard(IP, 'xteink_x4');
    expect(formatFeedPull(t.record(IP, { cards: 3, nextPullSec: 3600, now: NOW })))
      .toBe('card feed pull from xteink_x4 (192.168.68.77): 3 cards, next 3600s — first pull');
    expect(formatFeedPull(t.record(IP, { cards: 1, nextPullSec: 3600, now: NOW + 3708_000 })))
      .toBe('card feed pull from xteink_x4 (192.168.68.77): 1 card, next 3600s'
        + ' — 3708s since last pull (expected 3600s, +3.0%, cadence ok)');
  });
});

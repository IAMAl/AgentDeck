/**
 * Card Feed pull sync (M6) — the HTTP counterpart to the WS live mode for
 * wake-sync-sleep battery clients (XTeink X3/X4). Pure builders/appliers; the
 * HTTP routes live in daemon-server.ts. Contract: shared/src/protocol.ts
 * § Card Feed Pull Sync + docs/esp32-client-contract.md § Pull sync.
 *
 * M6 derives every card from a live session (the same rows `sessions_list`
 * broadcasts). M7 generalizes to daemon card modules (NUDGE / QUEST / …) that
 * will produce `day`-class cards; until then no producer emits `day`.
 */

import type {
  SessionInfo,
  FeedCard,
  CardFeedResponse,
  OutboxDecision,
  OutboxDecisionResult,
  OutboxPushRequest,
  OutboxPushResponse,
} from '@agentdeck/shared';
import {
  CARD_FEED_IDLE_PULL_SEC,
  CARD_FEED_ACTIVE_PULL_SEC,
} from '@agentdeck/shared';

/** A pulled permission gate is answerable only while the PreToolUse long-poll
 *  still holds the hook open (~60s) — pulled copies are honest about that. */
export const PERMISSION_GATE_TTL_MS = 60_000;
/** Awaiting PTY prompts stay interactive until the awaiting backstop reaps
 *  them (AWAITING_STUCK_TIMEOUT_MS) — same 10 min bound. */
export const AWAITING_PROMPT_TTL_MS = 10 * 60 * 1000;

const isAwaitingState = (s: SessionInfo): boolean =>
  typeof s.state === 'string' && s.state.startsWith('awaiting');

/** Offline-validity class for a session-derived card. Permission gates and
 *  interactive prompts are `live` (grey out offline, TTL-expire); everything
 *  else is a read-only `info` row. */
export function classifySessionCard(
  s: SessionInfo,
  now: number,
): Pick<FeedCard, 'actionClass' | 'expiresAt'> {
  if (s.requestId) return { actionClass: 'live', expiresAt: now + PERMISSION_GATE_TTL_MS };
  if (isAwaitingState(s)) return { actionClass: 'live', expiresAt: now + AWAITING_PROMPT_TTL_MS };
  return { actionClass: 'info' };
}

export function buildCardFeed(sessions: SessionInfo[], now: number = Date.now()): CardFeedResponse {
  const cards: FeedCard[] = sessions.map((s) => ({
    cardId: `session:${s.id}`,
    ...classifySessionCard(s, now),
    session: s,
  }));
  const active = sessions.some((s) => s.state === 'processing' || isAwaitingState(s));
  const d = new Date(now);
  const serverHm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return {
    type: 'card_feed',
    rev: 1,
    serverTime: now,
    serverHm,
    nextPullSec: active ? CARD_FEED_ACTIVE_PULL_SEC : CARD_FEED_IDLE_PULL_SEC,
    cards,
  };
}

export interface OutboxApplyDeps {
  /** Current enriched roster — validity checks run against *live* state. */
  sessions: SessionInfo[];
  /** Whether a permission gate is still held open (permission-resolver). */
  isPendingRequest(requestId: string): boolean;
  /** The daemon's device-command dispatch (handleDeviceCommand). Routing is
   *  fire-and-forget, so `applied` means accepted-for-delivery. */
  dispatch(cmd: Record<string, unknown>): void;
  now?: number;
}

const OUTBOX_ACTIONS = new Set(['permission_decision', 'select_option', 'respond', 'send_prompt', 'dismiss']);

function sessionIdOf(d: OutboxDecision): string | undefined {
  if (typeof d.sessionId === 'string' && d.sessionId) return d.sessionId;
  if (typeof d.cardId === 'string' && d.cardId.startsWith('session:')) return d.cardId.slice('session:'.length);
  return undefined;
}

function applyOne(d: OutboxDecision, deps: OutboxApplyDeps): OutboxDecisionResult {
  const cardId = typeof d.cardId === 'string' ? d.cardId : '';
  const fail = (status: OutboxDecisionResult['status'], reason: string): OutboxDecisionResult =>
    ({ cardId, status, reason });
  if (!cardId || typeof d.action !== 'string' || !OUTBOX_ACTIONS.has(d.action)) {
    return fail('rejected', 'malformed decision');
  }
  // Device-local dismissal — acknowledged so the device can drop it; the
  // daemon has nothing to mutate (dismissal memory lives on the device).
  if (d.action === 'dismiss') return { cardId, status: 'applied' };

  if (d.action === 'permission_decision') {
    if (typeof d.requestId !== 'string' || !d.requestId || (d.decision !== 'allow' && d.decision !== 'deny')) {
      return fail('rejected', 'requestId and decision required');
    }
    // A gate that is no longer held must NOT be re-resolved — the terminal
    // already answered it, or the hook long-poll gave up. Honest expiry.
    if (!deps.isPendingRequest(d.requestId)) return fail('expired', 'permission gate no longer pending');
    deps.dispatch({ type: 'permission_decision', requestId: d.requestId, decision: d.decision });
    return { cardId, status: 'applied' };
  }

  const sessionId = sessionIdOf(d);
  if (!sessionId) return fail('rejected', 'sessionId required');
  const session = deps.sessions.find((s) => s.id === sessionId);
  if (!session) return fail('unknown_card', 'session not in current roster');

  if (d.action === 'select_option' || d.action === 'respond') {
    // Option decisions answer a *specific* prompt. The session must still be
    // awaiting, and when the device echoed the question it must match the
    // session's current one — an hour-old index must never press a different,
    // newer prompt.
    if (!isAwaitingState(session) && !session.requestId) {
      return fail('expired', 'session is no longer awaiting');
    }
    if (typeof d.question === 'string' && d.question && session.question && d.question !== session.question) {
      return fail('expired', 'prompt changed since the decision was recorded');
    }
    if (d.action === 'select_option') {
      if (typeof d.index !== 'number' || !Number.isInteger(d.index) || d.index < 0) {
        return fail('rejected', 'index required');
      }
      deps.dispatch({ type: 'select_option', index: d.index, sessionId });
    } else {
      if (typeof d.value !== 'string' || !d.value) return fail('rejected', 'value required');
      deps.dispatch({ type: 'session_command', sessionId, command: { type: 'respond', value: d.value } });
    }
    return { cardId, status: 'applied' };
  }

  // send_prompt — deliverable to any alive session; observed sessions queue
  // it as a turn-end directive via the session_command steering path.
  if (typeof d.text !== 'string' || !d.text) return fail('rejected', 'text required');
  deps.dispatch({ type: 'session_command', sessionId, command: { type: 'send_prompt', text: d.text } });
  return { cardId, status: 'applied' };
}

/** Apply a pushed outbox batch. Results keep request order; every decision is
 *  acknowledged (the device deletes acknowledged entries regardless of
 *  status — a rejection is terminal, not retryable). */
export function applyOutboxDecisions(req: OutboxPushRequest, deps: OutboxApplyDeps): OutboxPushResponse {
  const decisions = Array.isArray(req?.decisions) ? req.decisions : [];
  const results = decisions.map((d) => {
    try {
      return applyOne(d ?? ({} as OutboxDecision), deps);
    } catch (err) {
      return {
        cardId: typeof d?.cardId === 'string' ? d.cardId : '',
        status: 'error' as const,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  });
  return { ok: results.every((r) => r.status !== 'error'), results };
}

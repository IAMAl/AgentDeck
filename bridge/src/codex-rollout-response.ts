/**
 * Extract a Codex turn's final response text from its rollout JSONL.
 *
 * Why this exists: observed (direct-run) Codex sessions reach the daemon
 * only through codex_* lifecycle hooks, and `codex_stop`'s stdin payload
 * does not reliably carry the assistant text (the Swift daemon probes
 * `last_assistant_message`/`response`/`output`/`result` and usually finds
 * nothing). The rollout Codex writes under `~/.codex/sessions/` DOES hold
 * it: `event_msg` records of type `agent_message` (`payload.message`) and,
 * at turn end, `task_complete` (`payload.last_agent_message`). This is the
 * Codex counterpart of `lastAssistantTextFromTranscript` for Claude —
 * hooks stay the boundary signal, the agent's own on-disk log supplies the
 * body, and nothing parses terminal output.
 *
 * Self-contained and read-only on purpose (mirrors
 * session-transcript-timeline.ts): never throws, returns '' when nothing
 * is found. Locating scans recent `~/.codex/sessions/<y>/<m>/<d>/` dirs
 * newest-first for `rollout-*-<sessionId>.jsonl` — the filename embeds the
 * session uuid, and scanning across day dirs (bounded) covers turns that
 * roll past midnight (memory: cross-day rollout selection).
 */

import { readdirSync, readFileSync, openSync, readSync, closeSync, fstatSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { debug } from './logger.js';

/** Max day directories to inspect, newest first. */
const MAX_DAY_DIRS = 30;
/** Tail window — final agent_message + task_complete land at the end. */
const TAIL_BYTES = 128 * 1024;

function numericDesc(names: string[]): string[] {
  return names
    .filter((n) => /^\d+$/.test(n))
    .sort((a, b) => Number(b) - Number(a));
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Locate `rollout-*-<sessionId>.jsonl` under the newest day dirs. */
export function locateCodexRollout(sessionId: string, sessionsRoot?: string): string | null {
  if (!sessionId || !/^[0-9a-f-]{8,}$/i.test(sessionId)) return null;
  const root = sessionsRoot ?? join(homedir(), '.codex', 'sessions');
  const suffix = `-${sessionId}.jsonl`;
  let dayDirsChecked = 0;
  for (const year of numericDesc(safeReaddir(root))) {
    for (const month of numericDesc(safeReaddir(join(root, year)))) {
      for (const day of numericDesc(safeReaddir(join(root, year, month)))) {
        if (++dayDirsChecked > MAX_DAY_DIRS) return null;
        const dir = join(root, year, month, day);
        for (const name of safeReaddir(dir)) {
          if (name.startsWith('rollout-') && name.endsWith(suffix)) {
            return join(dir, name);
          }
        }
      }
    }
  }
  return null;
}

function readTail(path: string, maxBytes: number): string {
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    try {
      return readFileSync(path, 'utf-8').slice(-maxBytes);
    } catch {
      return '';
    }
  }
}

/**
 * What the rollout says happened on a turn.
 *
 * A turn ends one of two ways and the tail records both, but only one used to
 * be read. `text` is the assistant's reply; `error` is the failure Codex wrote
 * instead — quota exhausted, a model the account may not use, a stream that
 * died. Codex does not run its `Stop` hook on a failed turn, so this file is
 * the ONLY place the failure is observable, and dropping it is what left a
 * turn spinning with its cause sitting unread on disk (issue: "ChatGPT free
 * request fails, timeline stays in progress").
 */
export interface CodexTurnOutcome {
  /** Assistant reply, empty when the turn produced none. */
  text: string;
  /** Human-readable failure text, when the turn ended in one. */
  error?: string;
  /** Codex's own classification, e.g. `usage_limit_exceeded`. */
  errorKind?: string;
}

/** Longest error text worth carrying onto a timeline row. */
const MAX_ERROR_CHARS = 400;

function cleanErrorText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let text = raw.trim();
  if (!text) return undefined;
  // Codex nests the upstream JSON body inside `message` for HTTP failures.
  // The useful sentence is the inner `message`; the envelope is noise.
  if (text.startsWith('{')) {
    try {
      const inner = JSON.parse(text) as Record<string, unknown>;
      const nested = (inner.message ?? (inner.error as Record<string, unknown> | undefined)?.message);
      if (typeof nested === 'string' && nested.trim()) text = nested.trim();
    } catch { /* not JSON after all — keep the raw text */ }
  }
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

/**
 * Parse the rollout tail for how the turn ended, newest record first.
 *
 * The scan stops at the turn's own opening record (`task_started` /
 * `user_message`). Without that stop a failed turn — which contributes no
 * `agent_message` of its own — kept walking into the PREVIOUS turn and
 * returned its reply as this one's, quietly attributing old text to a request
 * that never produced any.
 */
export function codexTurnOutcomeFromRollout(sessionId: string, sessionsRoot?: string): CodexTurnOutcome {
  const path = locateCodexRollout(sessionId, sessionsRoot);
  if (!path) return { text: '' };
  const lines = readTail(path, TAIL_BYTES).split('\n');
  let text = '';
  let error: string | undefined;
  let errorKind: string | undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // torn first line of the tail window
    }
    if (record.type !== 'event_msg') continue;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') continue;

    // Turn boundary — everything above belongs to an earlier turn.
    if (payload.type === 'task_started' || payload.type === 'user_message') break;

    if (payload.type === 'error') {
      error ??= cleanErrorText(payload.message);
      if (typeof payload.codex_error_info === 'string') errorKind ??= payload.codex_error_info;
      continue;
    }

    if (payload.type === 'task_complete') {
      const failure = payload.error as Record<string, unknown> | undefined;
      if (failure && typeof failure === 'object') {
        error ??= cleanErrorText(failure.message);
        if (typeof failure.codex_error_info === 'string') errorKind ??= failure.codex_error_info;
      }
      if (typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()) {
        return { text: payload.last_agent_message.trim(), error, errorKind };
      }
      continue;
    }

    if (!text && payload.type === 'agent_message'
        && typeof payload.message === 'string' && payload.message.trim()) {
      text = payload.message.trim();
      // task_complete always FOLLOWS agent_message, so scanning backwards past
      // this point can only reach older records.
      break;
    }
  }

  if (!text && !error) debug('codex-rollout', `no agent_message or error in tail of ${path}`);
  return { text, error, errorKind };
}

/**
 * Back-compat shim: the turn's reply text only.
 * Prefer `codexTurnOutcomeFromRollout`, which also reports failures.
 */
export function lastAgentMessageFromCodexRollout(sessionId: string, sessionsRoot?: string): string {
  return codexTurnOutcomeFromRollout(sessionId, sessionsRoot).text;
}

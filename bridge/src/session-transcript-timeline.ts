/**
 * Synthesize a per-session timeline from a Claude Code transcript JSONL.
 *
 * Why this exists: the bridge timeline store (`BridgeTimelineStore`) only holds
 * entries for sessions the daemon *relays* — managed sessions and hook events.
 * Passively-observed sessions (discovered by scanning `ps` + the
 * `~/.claude/projects/<proj>/<session>.jsonl` transcripts) never push timeline
 * rows, so a device that opens their Detail view via `query_session_timeline`
 * gets an empty reply ("No recent activity yet").
 *
 * This module fills that gap WITHOUT touching the relay path: given a session
 * id, it locates the session's transcript and replays the recent
 * user / assistant / tool_use records as `TimelineEntry[]` — the same shape the
 * device already renders (`sessionId` + `raw` + `type`). It is read-only and
 * never throws; callers treat `[]` as "nothing to show".
 *
 * Scope: CLI bridge only (the App Store Swift daemon has its own sandbox-safe
 * path). Self-contained on purpose — it does not import from the
 * concurrently-evolving `passive-observer.ts`/`claude-transcript-reader.ts`,
 * it only re-derives the small slice it needs (locate by session id, parse the
 * tail). Locating mirrors `findClaudeTranscript`: scan every project dir for
 * `<sessionId>.jsonl`, so no cwd is required.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { TimelineEntry, TimelineEntryType } from '@agentdeck/shared';
import { rawSessionId } from '@agentdeck/shared';
import { debug } from './logger.js';

/** Candidate `~/.claude` config roots (mirrors the bridge's discovery). The
 *  `CLAUDE_CONFIG_DIR` env can point elsewhere; fall back to `~/.claude`. */
function claudeConfigDirs(): string[] {
  const dirs = new Set<string>();
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) {
    for (const part of env.split(':')) {
      if (part.trim()) dirs.add(part.trim());
    }
  }
  dirs.add(join(homedir(), '.claude'));
  return [...dirs];
}

function safeRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Locate `<sessionId>.jsonl` under any `<config>/projects/<encoded-cwd>/` dir.
 *  Scans dirs because we don't carry the session's cwd here. Bounded to keep
 *  a pathological projects dir from stalling the WS reply. */
function locateTranscript(sessionId: string): string | null {
  for (const dir of claudeConfigDirs()) {
    const projects = join(dir, 'projects');
    try {
      for (const entry of readdirSync(projects, { withFileTypes: true }).slice(0, 250)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = join(projects, entry.name, `${sessionId}.jsonl`);
        if (safeRegularFile(candidate)) return candidate;
      }
    } catch {
      // Missing projects dir is normal for fresh installs / non-Claude agents.
    }
  }
  return null;
}

type JsonlRecord = {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

/** First non-empty line of a block of text, collapsed + trimmed to `max`. */
function oneLine(text: string, max = 90): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Pull `text` blocks out of a message `content` (string or block array),
 *  ignoring tool_result payloads which are not human-readable turn content. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join(' ');
}

/** Condense a tool_use block into a glanceable `Verb target` line. */
function toolLine(block: { name?: string; input?: unknown }): string {
  const name = typeof block.name === 'string' ? block.name : 'tool';
  const input = (block.input && typeof block.input === 'object'
    ? block.input as Record<string, unknown>
    : {});
  const str = (k: string): string | undefined =>
    typeof input[k] === 'string' ? input[k] as string : undefined;
  const basename = (p?: string): string => (p ? p.split('/').filter(Boolean).pop() || p : '');

  switch (name) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const f = basename(str('file_path') || str('notebook_path'));
      return f ? `${name === 'Write' ? 'Writing' : 'Editing'} ${f}` : name;
    }
    case 'Read': {
      const f = basename(str('file_path'));
      return f ? `Reading ${f}` : 'Reading';
    }
    case 'Bash': {
      const cmd = str('command');
      return cmd ? `Running ${oneLine(cmd, 60)}` : 'Running command';
    }
    case 'Grep': {
      const p = str('pattern');
      return p ? `Searching ${oneLine(p, 40)}` : 'Searching';
    }
    case 'Glob': {
      const p = str('pattern');
      return p ? `Finding ${oneLine(p, 40)}` : 'Finding files';
    }
    case 'Task': {
      const d = str('description');
      return d ? `Delegating ${oneLine(d, 50)}` : 'Delegating task';
    }
    case 'TodoWrite':
      return 'Updating todos';
    case 'WebFetch':
    case 'WebSearch':
      return name === 'WebSearch' ? 'Web search' : 'Fetching web page';
    default: {
      // MCP and other tools — show the tool name plus the first string arg.
      const firstStr = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      return firstStr ? `${name}: ${oneLine(firstStr, 50)}` : name;
    }
  }
}

export interface TranscriptTimelineOptions {
  /** Cap on the number of entries returned (most-recent wins). */
  limit?: number;
  /** Only return entries strictly newer than this epoch-ms timestamp. */
  since?: number;
}

/**
 * Build a recent-activity timeline for a session by replaying its transcript.
 *
 * `sessionId` is the id the device queried with (possibly `observed:claude:…`);
 * the returned entries carry that SAME id in `entry.sessionId` so the device's
 * Detail filter (keyed on the selected session id) matches.
 *
 * Returns `[]` when no transcript is found or it can't be parsed — never throws.
 */
export function transcriptTimelineForSession(
  sessionId: string,
  opts: TranscriptTimelineOptions = {},
): TimelineEntry[] {
  const limit = opts.limit ?? 16;
  const uuid = rawSessionId(sessionId);
  if (!uuid) return [];

  const transcript = locateTranscript(uuid);
  if (!transcript) {
    debug('daemon', `transcript-timeline: no transcript for ${uuid}`);
    return [];
  }

  let raw: string;
  try {
    raw = readFileSync(transcript, 'utf-8');
  } catch (err) {
    debug('daemon', `transcript-timeline read failed: ${String(err)}`);
    return [];
  }

  // The recent turns are always at the tail. Cap the scan to bound memory on
  // long-running sessions.
  const MAX_TAIL = 256 * 1024;
  const tail = raw.length > MAX_TAIL ? raw.slice(raw.length - MAX_TAIL) : raw;
  const lines = tail.split('\n');

  const entries: TimelineEntry[] = [];
  // Synthesize a monotonically-increasing ts when records lack a parseable
  // timestamp, so ordering is stable even on legacy transcripts.
  let synthTs = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: JsonlRecord;
    try {
      rec = JSON.parse(line) as JsonlRecord;
    } catch {
      continue; // skip malformed / partially-flushed tail line
    }
    const role = rec.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const parsedTs = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    const ts = Number.isFinite(parsedTs) ? parsedTs : ++synthTs;
    const content = rec.message?.content;

    if (role === 'user') {
      const text = textOf(content).trim();
      if (!text) continue; // tool_result-only continuation — not a real prompt
      entries.push(makeEntry(ts, 'chat_start', oneLine(text), sessionId));
      continue;
    }

    // assistant — emit its narration text, then one row per tool_use.
    const text = textOf(content).trim();
    if (text) {
      entries.push(makeEntry(ts, 'chat_response', oneLine(text), sessionId));
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; name?: string; input?: unknown };
        if (b.type === 'tool_use') {
          entries.push(makeEntry(ts, 'tool_request', toolLine(b), sessionId));
        }
      }
    }
  }

  // Synthetic ts (0,1,2…) and real epoch-ms ts never interleave in a single
  // transcript (a transcript either has timestamps or it doesn't), so a stable
  // tail slice gives the most-recent entries in order.
  const filtered = opts.since != null
    ? entries.filter((e) => e.ts > (opts.since as number))
    : entries;
  return filtered.slice(-limit);
}

function makeEntry(
  ts: number,
  type: TimelineEntryType,
  rawText: string,
  sessionId: string,
): TimelineEntry {
  return { ts, type, raw: rawText, sessionId };
}

/**
 * Last assistant text in a transcript file — the turn's response at Stop-hook
 * time. Used by the daemon's `/hook` handler to close hook-observed turns on
 * the timeline (`stop` carries `transcript_path` directly, so no session-id
 * scan is needed). Returns '' when the file is unreadable or the tail holds
 * no assistant text. Never throws.
 */
/**
 * Last assistant text for a session, found from its own transcript. Same source
 * the Stop handler reads, but addressable by session id — a turn that closed
 * without extractable text (the transcript had not flushed yet) can be asked
 * again a moment later.
 */
export function lastAssistantTextForSession(sessionId: string): string {
  const uuid = rawSessionId(sessionId);
  if (!uuid) return '';
  const transcript = locateTranscript(uuid);
  if (!transcript) return '';
  return lastAssistantTextFromTranscript(transcript);
}

export function lastAssistantTextFromTranscript(transcriptPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return '';
  }
  const MAX_TAIL = 256 * 1024;
  const tail = raw.length > MAX_TAIL ? raw.slice(raw.length - MAX_TAIL) : raw;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: JsonlRecord;
    try {
      rec = JSON.parse(line) as JsonlRecord;
    } catch {
      continue;
    }
    if (rec.message?.role === 'user') {
      // tool_result continuations are role:user with no readable text — skip
      // those; a *real* prompt (readable text) bounds the turn: no response.
      if (textOf(rec.message.content).trim()) break;
      continue;
    }
    if (rec.message?.role !== 'assistant') continue;
    const text = textOf(rec.message.content).trim();
    if (text) return text;
  }
  return '';
}

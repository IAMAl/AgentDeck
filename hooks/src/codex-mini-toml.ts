// codex-mini-toml.ts — minimal lossless TOML editor for ~/.codex/config.toml.
//
// Direct port of apple/AgentDeck/Daemon/Core/MiniToml.swift. Must stay
// byte-compatible: the fence sentinels are shared between the App Store
// Swift daemon and the Node CLI bridge so a config installed by either
// side can be uninstalled / re-applied by the other.
//
// We deliberately do NOT parse TOML semantically. Codex configs contain
// user-authored keys, comments, profile tables, and MCP server tables that
// we have no business round-tripping through a semantic serializer.
// AgentDeck-managed entries live inside a fenced block:
//
//     # >>> AgentDeck managed (do not edit) <<<
//     <our keys>
//     # <<< AgentDeck managed (do not edit) >>>
//
// applyManagedBlock replaces (or appends) the fence; removeManagedBlock
// strips it. Everything outside the fence is preserved byte-for-byte.

export const OPEN_FENCE = '# >>> AgentDeck managed (do not edit) <<<';
export const CLOSE_FENCE = '# <<< AgentDeck managed (do not edit) >>>';

/** Replace the AgentDeck-managed fenced block (or append one when none
 *  exists). The body is wrapped between OPEN_FENCE / CLOSE_FENCE so
 *  removeManagedBlock can strip it cleanly later. Returns the full
 *  updated TOML text. */
export function applyManagedBlock(text: string, body: string): string {
  const lines = splitLines(text);
  const fenceRange = locateFence(lines);

  const bodyLines = body.length === 0 ? [] : splitLines(body);
  let replacement = [OPEN_FENCE, ...bodyLines, CLOSE_FENCE];

  if (fenceRange) {
    const preservedHookState = extractCodexHookState(
      lines.slice(fenceRange.start + 1, fenceRange.end - 1)
    );
    if (preservedHookState.length > 0) {
      replacement = [...replacement, '', ...preservedHookState];
    }
    lines.splice(fenceRange.start, fenceRange.end - fenceRange.start, ...replacement);
  } else {
    // Pad with a blank line for readability when appending to a non-empty
    // file. Avoids glueing our fence onto the user's last key.
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('');
    }
    lines.push(...replacement);
  }
  return lines.join('\n');
}

/** Strip the AgentDeck-managed block entirely. Idempotent — no-op when
 *  the fence is absent. */
export function removeManagedBlock(text: string): string {
  const lines = splitLines(text);
  const fenceRange = locateFence(lines);
  if (!fenceRange) return text;
  lines.splice(fenceRange.start, fenceRange.end - fenceRange.start);
  // Collapse a trailing blank line that we may have inserted in
  // applyManagedBlock so removeManagedBlock truly returns the file to
  // its pre-apply shape.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  // Restore a single trailing newline if the original ended with one.
  if (text.endsWith('\n')) lines.push('');
  return lines.join('\n');
}

/** Detect a top-level `<key> = ...` definition outside the fence. Codex
 *  `notify` is a top-level key; if the user already wrote one our fenced
 *  `notify` would be a duplicate-key TOML error. */
export function hasTopLevelKeyOutsideFence(text: string, key: string): boolean {
  const escaped = escapeRegex(key);
  const regex = new RegExp(`^\\s*${escaped}\\s*=`);
  let insideFence = false;
  let insideTable = false;
  for (const line of splitLines(text)) {
    if (line === OPEN_FENCE) { insideFence = true; continue; }
    if (line === CLOSE_FENCE) { insideFence = false; continue; }
    if (insideFence) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      insideTable = true;
      continue;
    }
    if (insideTable) continue;
    if (regex.test(line)) return true;
  }
  return false;
}

/** Detect a `[<table>]`, `[<table>.subkey]`, or matching array-of-table
 *  header outside the fence. Codex `[otel]` / `[features]` tables collide
 *  with the fence we'd write. Hook arrays are handled separately because
 *  multiple `[[hooks.<Event>]]` entries are explicitly mergeable. */
export function hasTableOutsideFence(text: string, table: string): boolean {
  const escaped = escapeRegex(table);
  // Match exactly `[otel]`, `[otel.something]`, `[[otel.something]]`,
  // but not `[otelfoo]`. Whitespace inside brackets is permissive.
  const regex = new RegExp(`^\\s*\\[\\[?\\s*${escaped}(\\.[A-Za-z0-9_\\-]+)*\\s*\\]\\]?\\s*$`);
  let insideFence = false;
  for (const line of splitLines(text)) {
    if (line === OPEN_FENCE) { insideFence = true; continue; }
    if (line === CLOSE_FENCE) { insideFence = false; continue; }
    if (insideFence) continue;
    if (table === 'hooks' && isCodexHookStateHeader(line)) continue;
    if (regex.test(line)) return true;
  }
  return false;
}

/** Detect user-authored hook table shapes that cannot safely coexist with
 *  AgentDeck's lifecycle arrays. Official `[[hooks.<Event>]]` and nested
 *  `[[hooks.<Event>.hooks]]` arrays are mergeable and therefore allowed;
 *  regular `[hooks]` / `[hooks.<...>]` tables remain a conflict. Codex's
 *  generated `[hooks.state]` trust cache is metadata and is also ignored. */
export function hasIncompatibleHookTableOutsideFence(text: string): boolean {
  const anyHookHeader = /^\s*\[\[?\s*hooks(?:\.[^\]]+)?\s*\]\]?\s*$/;
  const mergeableLifecycleArray =
    /^\s*\[\[\s*hooks\.[A-Za-z0-9_-]+(?:\.hooks)?\s*\]\]\s*$/;
  let insideFence = false;
  for (const line of splitLines(text)) {
    if (line === OPEN_FENCE) { insideFence = true; continue; }
    if (line === CLOSE_FENCE) { insideFence = false; continue; }
    if (insideFence || isCodexHookStateHeader(line)) continue;
    if (!anyHookHeader.test(line)) continue;
    if (mergeableLifecycleArray.test(line)) continue;
    return true;
  }
  return false;
}

/** Quote a string as a TOML basic string. Escape backslash, double quote,
 *  and control characters so the output is always single-line safe. */
export function quoted(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  out += '"';
  return out;
}

// ─── internals ──────────────────────────────────────────────────────────

function splitLines(text: string): string[] {
  // String.split('\n') keeps trailing-empty so an input ending in "\n"
  // round-trips cleanly when re-joined with "\n".
  return text.split('\n');
}

interface FenceRange { start: number; end: number; }

function locateFence(lines: string[]): FenceRange | null {
  const start = lines.indexOf(OPEN_FENCE);
  if (start === -1) return null;
  // Find first close fence at-or-after start. Defensive against truncated
  // files: if no close fence is found, treat everything from the open
  // fence to the end as managed.
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === CLOSE_FENCE) { end = i; break; }
  }
  if (end === -1) end = lines.length - 1;
  return { start, end: end + 1 };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCodexHookState(lines: string[]): string[] {
  const out: string[] = [];
  let capturing = false;
  for (const line of lines) {
    const tableHeader = isTableHeader(line);
    if (isCodexHookStateHeader(line)) {
      capturing = true;
      out.push(line);
      continue;
    }
    if (capturing && tableHeader) {
      break;
    }
    if (capturing) {
      out.push(line);
    }
  }
  while (out.length > 0 && isTrailingNonDataLine(out[out.length - 1])) {
    out.pop();
  }
  return out;
}

function isCodexHookStateHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '[hooks.state]' || (trimmed.startsWith('[hooks.state.') && trimmed.endsWith(']'));
}

function isTableHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']');
}

function isTrailingNonDataLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith('#');
}

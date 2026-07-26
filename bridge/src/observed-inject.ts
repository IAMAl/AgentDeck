/**
 * Deliver an option selection INTO an observed (plain `claude`) session's
 * terminal — the rung of the observed-steering ladder that answers a live
 * AskUserQuestion/selector prompt without any hold-and-timeout machinery:
 * the prompt is already on screen; the daemon types the same keys the user
 * would (Down × index from the top, then Enter — Claude's pickers start with
 * the cursor on the first option).
 *
 * Transport ladder, keyed by the session's controlling tty (from the passive
 * process scan):
 *   1. tmux — the pane whose #{pane_tty} matches gets `send-keys Down… Enter`
 *      (headless, no permissions).
 *   2. iTerm2 — the session whose `tty` matches gets AppleScript `write text`
 *      keystrokes (one-time macOS Automation consent for the daemon process).
 *
 * Node-daemon only by design: the App Store Swift daemon spawns no
 * subprocesses, so this stays a CLI-daemon (Tier 2) capability.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { debug } from './logger.js';

const execFileAsync = promisify(execFile);

export interface InjectResult {
  ok: boolean;
  via?: 'tmux' | 'iterm2';
  reason?: string;
}

/** Parse `tmux list-panes -a -F "#{pane_tty}\t#{pane_id}"` output into a
 *  tty-suffix → paneId map ("/dev/ttys012" is matched by "ttys012"). */
export function parseTmuxPanes(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split('\n')) {
    const [paneTty, paneId] = line.trim().split('\t');
    if (!paneTty || !paneId) continue;
    map.set(paneTty.replace(/^\/dev\//, ''), paneId);
  }
  return map;
}

async function injectViaTmux(tty: string, downs: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'tmux', ['list-panes', '-a', '-F', '#{pane_tty}\t#{pane_id}'],
      { encoding: 'utf8', timeout: 2_000 },
    );
    const paneId = parseTmuxPanes(stdout).get(tty);
    if (!paneId) return false;
    const keys = [...Array(downs).fill('Down'), 'Enter'];
    await execFileAsync('tmux', ['send-keys', '-t', paneId, ...keys],
      { timeout: 2_000 });
    return true;
  } catch {
    return false; // no tmux server / pane gone — fall through the ladder
  }
}

/** AppleScript that types the selection into the iTerm2 session owning `tty`.
 *  Exported for tests. */
export function buildItermSelectScript(tty: string, downs: number): string {
  // ESC [ B per Down, then a bare `write text ""` for Enter (write text
  // appends CR by default; the arrow writes suppress it with `newline NO`).
  const writes: string[] = [];
  for (let i = 0; i < downs; i++) {
    writes.push('write s text ((character id 27) & "[B") newline NO');
  }
  writes.push('write s text ""');
  return [
    'tell application "iTerm2"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      repeat with s in sessions of t',
    `        if tty of s is "/dev/${tty}" then`,
    ...writes.map((l) => `          ${l}`),
    '          return "ok"',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end repeat',
    'end tell',
    'return "notfound"',
  ].join('\n');
}

async function injectViaIterm(tty: string, downs: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'osascript', ['-e', buildItermSelectScript(tty, downs)],
      { encoding: 'utf8', timeout: 5_000 },
    );
    return stdout.trim() === 'ok';
  } catch (err) {
    debug('inject', `iTerm2 injection failed: ${String(err).slice(0, 160)}`);
    return false; // no iTerm2 / automation consent denied
  }
}

/**
 * Type "Down × index, Enter" into the observed session's terminal.
 * `tty` is the short form from the process scan ("ttys008").
 */
export async function injectObservedSelection(
  tty: string | undefined,
  index: number,
): Promise<InjectResult> {
  if (!tty) return { ok: false, reason: 'no tty for session' };
  if (index < 0 || index > 16) return { ok: false, reason: 'index out of range' };
  if (await injectViaTmux(tty, index)) return { ok: true, via: 'tmux' };
  if (await injectViaIterm(tty, index)) return { ok: true, via: 'iterm2' };
  return { ok: false, reason: 'no reachable terminal (tmux/iTerm2)' };
}

/**
 * Deliver an option selection INTO an observed session's own UI — the rung of
 * the observed-steering ladder that answers a live prompt without any
 * hold-and-timeout machinery: the prompt is already on screen; the daemon does
 * what the user would do, and if it cannot reach the UI **nothing happens**
 * (the prompt keeps waiting — never an auto-proceed).
 *
 * Two families of host, resolved by the passive observer:
 *
 *   Terminal-hosted (`tty` known) — the session runs in a real terminal, so
 *   the answer is keystrokes into that terminal's own input:
 *     1. tmux — the pane whose `#{pane_tty}` matches gets `send-keys`.
 *     2. iTerm2 — the session whose `tty` matches gets `write text` (no focus
 *        change; iTerm2 writes straight into the session).
 *     3. Terminal.app — has no write API, so: remember the frontmost app,
 *        select the tab owning that tty, post key events, restore focus.
 *
 *   App-hosted (`appName` known, no tty) — Claude.app / ChatGPT.app run the
 *   agent inside a native window, so the answer is that window's own control:
 *     4. Press the button whose title matches the chosen option's label
 *        (AXPress — precise, and no focus steal).
 *     5. Fall back to key events with raise+restore when no button matches
 *        (list-style pickers).
 *
 * TIOCSTI (the one kernel path that would cover every emulator at once) is
 * rejected by macOS with EPERM unless the tty is the caller's own controlling
 * terminal — measured 2026-07-26, do not retry it.
 *
 * Node-daemon only by design: every rung needs a subprocess (tmux/osascript),
 * which the App Store Swift daemon must never spawn. See
 * docs/appstore-feature-matrix.md.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { debug } from './logger.js';

const execFileAsync = promisify(execFile);

export interface InjectTarget {
  /** Controlling terminal short name ("ttys008") for terminal-hosted sessions. */
  tty?: string;
  /** Owning application ("Claude", "ChatGPT") for app-hosted sessions. */
  appName?: string;
  /** Visible label of the chosen option — lets app-hosted rungs press the
   *  matching native button instead of guessing at cursor movement. */
  label?: string;
}

export interface InjectResult {
  ok: boolean;
  via?: 'tmux' | 'iterm2' | 'terminal-app' | 'app-button' | 'app-keys';
  reason?: string;
}

/** AppleScript string literal escaping (quotes + backslashes). */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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

/** AppleScript that types the selection into the iTerm2 session owning `tty`. */
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

/**
 * AppleScript for Terminal.app: locate the tab whose `tty` matches, bring it
 * forward, post Down×n + Return through System Events, then restore whatever
 * app was frontmost. Terminal.app exposes no write API, so a brief focus
 * change is unavoidable — it is restored in the same script so the user's
 * typing target is not left hijacked.
 */
export function buildTerminalAppSelectScript(tty: string, downs: number): string {
  const keyLines: string[] = [];
  for (let i = 0; i < downs; i++) keyLines.push('key code 125'); // Down
  keyLines.push('key code 36'); // Return
  return [
    'set prevApp to ""',
    'try',
    '  tell application "System Events" to set prevApp to name of first process whose frontmost is true',
    'end try',
    'set found to false',
    'tell application "Terminal"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    `      if tty of t is "/dev/${tty}" then`,
    '        set selected of t to true',
    '        set index of w to 1',
    '        set found to true',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if found then exit repeat',
    '  end repeat',
    'end tell',
    'if not found then return "notfound"',
    'tell application "Terminal" to activate',
    'delay 0.15',
    'tell application "System Events"',
    ...keyLines.map((l) => `  ${l}`),
    'end tell',
    'delay 0.05',
    'if prevApp is not "" and prevApp is not "Terminal" then',
    '  try',
    '    tell application prevApp to activate',
    '  end try',
    'end if',
    'return "ok"',
  ].join('\n');
}

/**
 * AppleScript for an app-hosted session: press the button whose title matches
 * the option label inside the app's front window. Matching is
 * case-insensitive and prefix-tolerant (native buttons often shorten a long
 * option label). AXPress needs no focus change, so this is the preferred
 * app-hosted rung.
 */
export function buildAppButtonPressScript(appName: string, label: string): string {
  const app = escapeAppleScript(appName);
  // AppleScript text comparison ignores case by default — no lowercasing dance.
  const want = escapeAppleScript(label.trim());
  // `entire contents` yields a flat element list; AppleScript cannot filter it
  // with `every button of …`, so iterate and test the accessibility role.
  return [
    `tell application "System Events" to tell process "${app}"`,
    '  if not (exists window 1) then return "nowindow"',
    '  set target to missing value',
    '  repeat with e in (entire contents of window 1)',
    '    try',
    '      if role of e is "AXButton" or role of e is "AXRadioButton" then',
    '        set bt to name of e',
    '        if bt is not missing value and bt is not "" then',
    `          if bt is "${want}" or bt starts with "${want}" or "${want}" starts with bt then`,
    '            set target to e',
    '            exit repeat',
    '          end if',
    '        end if',
    '      end if',
    '    end try',
    '  end repeat',
    '  if target is missing value then return "nobutton"',
    '  click target',
    '  return "ok"',
    'end tell',
  ].join('\n');
}

/**
 * Key-event fallback for an app-hosted session: raise the app, post Down×n +
 * Return, restore the previous frontmost app.
 */
export function buildAppKeysScript(appName: string, downs: number): string {
  const app = escapeAppleScript(appName);
  const keyLines: string[] = [];
  for (let i = 0; i < downs; i++) keyLines.push('key code 125');
  keyLines.push('key code 36');
  return [
    'set prevApp to ""',
    'try',
    '  tell application "System Events" to set prevApp to name of first process whose frontmost is true',
    'end try',
    `tell application "${app}" to activate`,
    'delay 0.15',
    'tell application "System Events"',
    ...keyLines.map((l) => `  ${l}`),
    'end tell',
    'delay 0.05',
    `if prevApp is not "" and prevApp is not "${app}" then`,
    '  try',
    '    tell application prevApp to activate',
    '  end try',
    'end if',
    'return "ok"',
  ].join('\n');
}

async function runOsa(script: string, timeoutMs = 8_000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script],
      { encoding: 'utf8', timeout: timeoutMs });
    return stdout.trim();
  } catch (err) {
    debug('inject', `osascript failed: ${String(err).slice(0, 200)}`);
    return null;
  }
}

/**
 * Answer the session's on-screen prompt by driving its host UI.
 * `index` is the zero-based option position (Claude's pickers start with the
 * cursor on the first option, so index == the number of Down presses).
 */
export async function injectObservedSelection(
  target: InjectTarget,
  index: number,
): Promise<InjectResult> {
  if (index < 0 || index > 16) return { ok: false, reason: 'index out of range' };
  const { tty, appName, label } = target;
  if (!tty && !appName) return { ok: false, reason: 'no tty or app host for session' };

  if (tty) {
    if (await injectViaTmux(tty, index)) return { ok: true, via: 'tmux' };
    if (await runOsa(buildItermSelectScript(tty, index), 5_000) === 'ok') {
      return { ok: true, via: 'iterm2' };
    }
    if (await runOsa(buildTerminalAppSelectScript(tty, index)) === 'ok') {
      return { ok: true, via: 'terminal-app' };
    }
    return { ok: false, reason: `no reachable terminal for ${tty}` };
  }

  // App-hosted: prefer pressing the labelled control (no focus steal).
  if (label) {
    const r = await runOsa(buildAppButtonPressScript(appName!, label));
    if (r === 'ok') return { ok: true, via: 'app-button' };
    debug('inject', `app-button press on ${appName}: ${r ?? 'error'}`);
  }
  if (await runOsa(buildAppKeysScript(appName!, index)) === 'ok') {
    return { ok: true, via: 'app-keys' };
  }
  return { ok: false, reason: `no reachable UI in ${appName}` };
}

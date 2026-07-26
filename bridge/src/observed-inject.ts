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
 *     3. Terminal.app — has no write API, so: select the tab owning that tty
 *        (scriptable, no activation) and post keys to Terminal's pid.
 *
 *   App-hosted (`appName` known, no tty) — Claude.app / ChatGPT.app run the
 *   agent inside a native window, so the answer is that window's own control:
 *     4. Press the button whose title matches the chosen option's label
 *        (AXPress — precise; works for native AppKit dialogs).
 *     5. Post keys to the app's pid (focus-free).
 *     6. Raise + keys + restore, only if the app ignores posted events.
 *
 * Every rung is focus-free except the last: measured 2026-07-26, keys posted
 * with `CGEventPostToPid` reached a background Terminal tab while iTerm2
 * stayed frontmost.
 *
 * Two measured dead ends, recorded so they are not retried:
 *   • TIOCSTI — the one kernel path that would cover every emulator at once —
 *     is EPERM on macOS unless the tty is the caller's own controlling
 *     terminal.
 *   • ChatGPT.app exposes no content in its accessibility tree (its window is
 *     three untitled AXButtons plus empty AXGroups, and
 *     `AXManualAccessibility` returns kAXErrorAttributeUnsupported), so the
 *     button rung cannot see its controls — key posting is the working path
 *     for that host.
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

/** Known bundle ids for GUI agent hosts — matched before localized names,
 *  which differ per system language. */
const APP_BUNDLE_IDS: Record<string, string[]> = {
  Claude: ['com.anthropic.claudefordesktop', 'com.anthropic.claude'],
  ChatGPT: ['com.openai.chat'],
  Terminal: ['com.apple.Terminal'],
  iTerm2: ['com.googlecode.iterm2'],
};

export interface InjectResult {
  ok: boolean;
  via?: 'tmux' | 'iterm2' | 'terminal-app' | 'app-button' | 'app-keys' | 'app-keys-raised';
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
 * AppleScript for Terminal.app: select the tab whose `tty` matches, WITHOUT
 * activating the app. Keys are then posted straight to Terminal's pid
 * (`buildPostKeysScript`), so answering a prompt never steals the user's
 * focus — measured 2026-07-26: iTerm2 stayed frontmost while the Terminal
 * tab received ESC[B + CR.
 */
export function buildTerminalAppSelectTabScript(tty: string): string {
  return [
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
    'if found then',
    '  return "ok"',
    'else',
    '  return "notfound"',
    'end if',
  ].join('\n');
}

/**
 * JXA that posts Down×n + Return directly to a running app's process with
 * `CGEventPostToPid` — the event reaches that app's key window without
 * raising it, so the user's foreground work is untouched.
 *
 * The app is matched by bundle id first and localized name second: on a
 * Korean system `Terminal` is "터미널", so name matching alone silently
 * missed it.
 *
 * Requires Accessibility permission for whatever process runs the daemon
 * (the terminal that launched it, or the LaunchAgent itself).
 */
export function buildPostKeysScript(
  match: { bundleIds?: string[]; names?: string[] },
  downs: number,
): string {
  const bundles = JSON.stringify(match.bundleIds ?? []);
  const names = JSON.stringify(match.names ?? []);
  return [
    "ObjC.import('ApplicationServices'); ObjC.import('AppKit');",
    `const wantBundles = ${bundles}; const wantNames = ${names};`,
    'function findPid() {',
    '  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;',
    '  for (let i = 0; i < apps.count; i++) {',
    '    const a = apps.objectAtIndex(i);',
    '    const b = ObjC.unwrap(a.bundleIdentifier);',
    '    if (b && wantBundles.indexOf(b) >= 0) return a.processIdentifier;',
    '  }',
    '  for (let i = 0; i < apps.count; i++) {',
    '    const a = apps.objectAtIndex(i);',
    '    const n = ObjC.unwrap(a.localizedName);',
    '    if (n && wantNames.indexOf(n) >= 0) return a.processIdentifier;',
    '  }',
    '  return -1;',
    '}',
    'const pid = findPid();',
    'if (pid < 0) { "notfound" } else {',
    '  function key(code) {',
    '    const d = $.CGEventCreateKeyboardEvent($(), code, true);',
    '    const u = $.CGEventCreateKeyboardEvent($(), code, false);',
    '    $.CGEventPostToPid(pid, d); $.CGEventPostToPid(pid, u);',
    '    delay(0.12);',
    '  }',
    // A background app drops the first posted events until its input queue is
    // warm: measured with 0.05s pacing and no lead-in, two Downs vanished and
    // only the Return landed (which would silently pick the WRONG option).
    '  delay(0.30);',
    `  for (let i = 0; i < ${downs}; i++) key(125);`,
    '  key(36);',
    '  "ok"',
    '}',
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
 * Last-resort key path: raise the app, post Down×n + Return through System
 * Events, restore the previous frontmost app. Only used when the focus-free
 * `CGEventPostToPid` route reports the app is not running or the app ignores
 * posted events.
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

async function runJxa(script: string, timeoutMs = 8_000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script],
      { encoding: 'utf8', timeout: timeoutMs });
    return stdout.trim();
  } catch (err) {
    debug('inject', `jxa failed: ${String(err).slice(0, 200)}`);
    return null;
  }
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
    // Terminal.app: select the owning tab (no activation), then post keys to
    // its pid — focus-free.
    if (await runOsa(buildTerminalAppSelectTabScript(tty), 5_000) === 'ok') {
      const posted = await runJxa(
        buildPostKeysScript({ bundleIds: ['com.apple.Terminal'], names: ['Terminal', '터미널'] }, index),
      );
      if (posted === 'ok') return { ok: true, via: 'terminal-app' };
      debug('inject', `Terminal.app tab selected but key post failed: ${posted ?? 'error'}`);
    }
    return { ok: false, reason: `no reachable terminal for ${tty}` };
  }

  // App-hosted. Try the labelled control first (works for native AppKit
  // dialogs); then focus-free key posting; raise+restore only as last resort.
  if (label) {
    const r = await runOsa(buildAppButtonPressScript(appName!, label));
    if (r === 'ok') return { ok: true, via: 'app-button' };
    debug('inject', `app-button press on ${appName}: ${r ?? 'error'}`);
  }
  const posted = await runJxa(
    buildPostKeysScript({ bundleIds: APP_BUNDLE_IDS[appName!] ?? [], names: [appName!] }, index),
  );
  if (posted === 'ok') return { ok: true, via: 'app-keys' };
  if (await runOsa(buildAppKeysScript(appName!, index)) === 'ok') {
    return { ok: true, via: 'app-keys-raised' };
  }
  return { ok: false, reason: `no reachable UI in ${appName}` };
}

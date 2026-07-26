import { describe, it, expect } from 'vitest';
import {
  parseTmuxPanes, buildItermSelectScript, buildTerminalAppSelectScript,
  buildAppButtonPressScript, buildAppKeysScript, escapeAppleScript,
} from '../observed-inject.js';
import { parseProcessTable, appNameFromCommand, resolveHostApp } from '../passive-observer.js';

describe('parseTmuxPanes', () => {
  it('maps pane ttys (dev-prefix stripped) to pane ids', () => {
    const out = '/dev/ttys004\t%1\n/dev/ttys008\t%3\n';
    const map = parseTmuxPanes(out);
    expect(map.get('ttys008')).toBe('%3');
    expect(map.get('ttys004')).toBe('%1');
  });

  it('ignores malformed lines', () => {
    expect(parseTmuxPanes('garbage\n\n').size).toBe(0);
  });
});

describe('buildItermSelectScript', () => {
  it('targets the session by tty and types Down x index then Enter', () => {
    const s = buildItermSelectScript('ttys008', 2);
    expect(s).toContain('if tty of s is "/dev/ttys008"');
    expect(s.match(/character id 27/g)?.length).toBe(2);
    expect(s).toContain('write s text ""');
  });

  it('index 0 is a bare Enter', () => {
    const s = buildItermSelectScript('ttys001', 0);
    expect(s).not.toContain('character id 27');
    expect(s).toContain('write s text ""');
  });
});

describe('parseProcessTable with tty column', () => {
  it('parses tty and treats ?? as none', () => {
    const out = '  123   1  1000 ttys008 claude\n  456   1  2000 ?? claude daemon run\n';
    const rows = parseProcessTable(out);
    expect(rows[0].tty).toBe('ttys008');
    expect(rows[1].tty).toBeUndefined();
  });
});

describe('buildTerminalAppSelectScript', () => {
  it('finds the tab by tty, keys Down x index + Return, restores focus', () => {
    const s = buildTerminalAppSelectScript('ttys003', 2);
    expect(s).toContain('if tty of t is "/dev/ttys003"');
    expect(s.match(/key code 125/g)?.length).toBe(2);
    expect(s).toContain('key code 36');
    expect(s).toContain('tell application prevApp to activate');
  });

  it('returns notfound when no tab matches', () => {
    expect(buildTerminalAppSelectScript('ttys009', 0)).toContain('return "notfound"');
  });
});

describe('buildAppButtonPressScript', () => {
  it('matches the button by label with prefix tolerance and clicks it', () => {
    const s = buildAppButtonPressScript('ChatGPT', 'Allow once');
    expect(s).toContain('tell process "ChatGPT"');
    expect(s).toContain('bt is "Allow once"');
    expect(s).toContain('bt starts with "Allow once"');
    expect(s).toContain('click target');
    // AXPress path must never raise the app
    expect(s).not.toContain('activate');
  });

  it('escapes quotes in labels', () => {
    expect(buildAppButtonPressScript('Claude', 'Say "hi"')).toContain('Say \\"hi\\"');
  });
});

describe('buildAppKeysScript', () => {
  it('raises the app, keys, and restores the previous frontmost app', () => {
    const s = buildAppKeysScript('Claude', 1);
    expect(s).toContain('tell application "Claude" to activate');
    expect(s.match(/key code 125/g)?.length).toBe(1);
    expect(s).toContain('tell application prevApp to activate');
  });
});

describe('escapeAppleScript', () => {
  it('escapes backslashes and quotes', () => {
    expect(escapeAppleScript('a\\b"c')).toBe('a\\\\b\\"c');
  });
});

describe('app-host resolution', () => {
  it('extracts the app name from a bundle path', () => {
    expect(appNameFromCommand('/Applications/ChatGPT.app/Contents/Resources/codex app-server'))
      .toBe('ChatGPT');
    expect(appNameFromCommand('/Users/me/.local/bin/claude')).toBeUndefined();
  });

  it('walks the ancestry to find the hosting app', () => {
    const rows = parseProcessTable([
      ' 100 1 1000 ?? /Applications/Claude.app/Contents/MacOS/Claude',
      ' 200 100 1000 ?? /Users/me/.local/bin/node helper.js',
      ' 300 200 1000 ?? /Users/me/.local/bin/claude',
    ].join('\n'));
    const byPid = new Map(rows.map((p) => [p.pid, p]));
    expect(resolveHostApp(300, byPid)).toBe('Claude');
  });

  it('returns undefined for a plain terminal session', () => {
    const rows = parseProcessTable([
      ' 10 1 1000 ttys001 -zsh',
      ' 20 10 1000 ttys001 /Users/me/.local/bin/claude',
    ].join('\n'));
    const byPid = new Map(rows.map((p) => [p.pid, p]));
    expect(resolveHostApp(20, byPid)).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { parseTmuxPanes, buildItermSelectScript } from '../observed-inject.js';
import { parseProcessTable } from '../passive-observer.js';

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

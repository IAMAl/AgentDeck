import { describe, it, expect } from 'vitest';
import {
  parsePeripheralMappings, resolvePeripheralAction, commandForAction,
} from '../peripheral-mapping.js';

const SESSIONS = [
  { id: 'observed:claude:aaa', projectName: 'Remin', state: 'processing' },
  { id: 'observed:claude:bbb', projectName: 'AgentDeck', state: 'awaiting_permission', requestId: 'req-1' },
  { id: 'observed:claude:ccc', projectName: 'AgentDeck', state: 'idle' },
];

describe('parsePeripheralMappings', () => {
  it('keeps valid entries and drops malformed ones', () => {
    const m = parsePeripheralMappings({
      peripheralMappings: [
        { kind: 'nfc_tag', uid: '04A1', action: 'focus', project: 'Remin' },
        { kind: 'nfc_tag', action: 'approve' },          // no uid/code
        { kind: 'bogus', uid: 'x', action: 'focus' },     // bad kind
        { kind: 'nfc_tag', uid: 'y', action: 'explode' }, // bad action
        'nonsense',
      ],
    });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ uid: '04A1', action: 'focus', project: 'Remin' });
  });

  it('returns empty when the block is absent or not an array', () => {
    expect(parsePeripheralMappings({})).toEqual([]);
    expect(parsePeripheralMappings({ peripheralMappings: 'x' })).toEqual([]);
  });
});

describe('resolvePeripheralAction', () => {
  const mappings = parsePeripheralMappings({
    peripheralMappings: [
      { kind: 'nfc_tag', uid: '04A1B2C3', action: 'focus', project: 'Remin' },
      { kind: 'nfc_tag', uid: '0455C1D2', action: 'approve' },
      { kind: 'ir_rx', code: 'NEC:20DF10EF', action: 'stop', project: 'AgentDeck' },
    ],
  });

  it('matches a tag case-insensitively and honors the project filter', () => {
    const r = resolvePeripheralAction({ kind: 'nfc_tag', uid: '04a1b2c3' }, mappings, SESSIONS);
    expect(r?.action).toBe('focus');
    expect(r?.session.projectName).toBe('Remin');
  });

  it('without a project filter targets the session that needs a human', () => {
    const r = resolvePeripheralAction({ kind: 'nfc_tag', uid: '0455C1D2' }, mappings, SESSIONS);
    expect(r?.session.state).toBe('awaiting_permission');
  });

  it('matches IR codes too', () => {
    const r = resolvePeripheralAction({ kind: 'ir_rx', code: 'nec:20df10ef' }, mappings, SESSIONS);
    expect(r?.action).toBe('stop');
  });

  it('returns undefined for an unmapped tag or an empty roster', () => {
    expect(resolvePeripheralAction({ kind: 'nfc_tag', uid: 'FFFF' }, mappings, SESSIONS)).toBeUndefined();
    expect(resolvePeripheralAction({ kind: 'nfc_tag', uid: '04A1B2C3' }, mappings, [])).toBeUndefined();
  });

  it('does not cross kinds (an nfc uid never matches an ir event)', () => {
    expect(resolvePeripheralAction({ kind: 'ir_rx', code: '04A1B2C3' }, mappings, SESSIONS)).toBeUndefined();
  });
});

describe('commandForAction', () => {
  const awaiting = SESSIONS[1];
  const idle = SESSIONS[2];

  it('approve prefers a held gate and falls back to the live prompt', () => {
    expect(commandForAction({ action: 'approve', session: awaiting }))
      .toEqual({ type: 'permission_decision', requestId: 'req-1', decision: 'allow' });
    expect(commandForAction({ action: 'approve', session: idle }))
      .toEqual({ type: 'select_option', sessionId: idle.id, index: 0 });
  });

  it('deny mirrors approve', () => {
    expect(commandForAction({ action: 'deny', session: awaiting }))
      .toMatchObject({ type: 'permission_decision', decision: 'deny' });
    expect(commandForAction({ action: 'deny', session: idle }))
      .toMatchObject({ type: 'session_command', command: { type: 'escape' } });
  });

  it('maps focus / review / stop to existing daemon commands', () => {
    expect(commandForAction({ action: 'focus', session: idle })?.type).toBe('focus_session');
    expect(commandForAction({ action: 'review', session: idle })?.type).toBe('review_run');
    expect(commandForAction({ action: 'stop', session: idle }))
      .toMatchObject({ type: 'session_command', command: { type: 'interrupt' } });
  });
});

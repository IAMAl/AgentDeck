import { describe, it, expect } from 'vitest';
import { ASK_ECHO_MIN_PREFIX, askEchoMatches, askGateDecision, askPressVerdict } from '../ask-gate.js';

/**
 * The two decisions that make the ask-gate safe. Both fail silently in the
 * field — one leaves a terminal blank with nobody able to answer, the other
 * commits an answer the user never gave — so each rule gets an explicit case.
 */

describe('askGateDecision — who pays for the hold', () => {
  const host = (o: { tty?: string; appName?: string } | undefined) =>
    askGateDecision({ enabled: true, clientCount: 1, observed: o });

  it('holds only when there is no way to type into the session', () => {
    expect(host({}).hold).toBe(true);
  });

  it('never holds when the answer could be typed instead', () => {
    // Holding would make the person at that terminal wait for their own
    // picker; injection answers it with no delay at all.
    expect(host({ tty: 'ttys006' }).hold).toBe(false);
    expect(host({ appName: 'Claude' }).hold).toBe(false);
  });

  it('never holds a session no device can see', () => {
    // The observer roster is the only source of observed:claude:* rows, so a
    // session missing from it is a session missing from every deck. Holding
    // there stalls a question with nobody to answer it — the inverse of the
    // intent. Reachable for real: a session younger than the scan interval, or
    // any ps failure, empties that roster.
    const d = host(undefined);
    expect(d.hold).toBe(false);
    expect(d.reason).toMatch(/roster/);
  });

  it('never holds with the gate off or nobody connected', () => {
    expect(askGateDecision({ enabled: false, clientCount: 1, observed: {} }).hold).toBe(false);
    expect(askGateDecision({ enabled: true, clientCount: 0, observed: {} }).hold).toBe(false);
  });
});

describe('askPressVerdict — what may commit an answer', () => {
  const overlay = {
    question: 'Which colour do you prefer?',
    options: [{ index: 0, label: 'Red' }, { index: 1, label: 'Blue' }],
    toolUseId: 'toolu-1',
  };
  const press = (command: Record<string, unknown>, gateToolUseId = 'toolu-1') =>
    askPressVerdict({ overlay, gateToolUseId, command });

  it('accepts a press that names the live question', () => {
    const v = press({ type: 'select_option', index: 1, question: overlay.question });
    expect(v).toEqual({ ok: true, label: 'Blue' });
  });

  it('refuses a press that does not name its question', () => {
    // This is the ESP32/NFC "approve" key, which sends select_option(0) as a
    // stand-in for a yes/no gate. Against a multiple-choice question that is a
    // guess, and accepting it would submit option 0 as the user's own answer.
    const v = press({ type: 'select_option', index: 0 });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/name its question/);
      // Nothing to resync — that sender has no question view to correct.
      expect(v.resync).toBe(false);
    }
  });

  it('refuses a press aimed at a question the prompt moved past', () => {
    const v = press({ type: 'select_option', index: 0, question: 'Which animal do you prefer?' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.resync).toBe(true);
  });

  it('refuses to answer an overlay the held gate does not own', () => {
    // A malformed follow-up call can leave the previous prompt resident;
    // answering it would report the wrong question back to the agent.
    const v = press({ type: 'select_option', index: 0, question: overlay.question }, 'toolu-other');
    expect(v.ok).toBe(false);
  });

  it('refuses anything that is not an option selection', () => {
    // A yes/no `respond` must never collapse a multiple-choice question.
    expect(press({ type: 'respond', value: 'y', question: overlay.question }).ok).toBe(false);
  });

  it('refuses an index that is not in the live option list', () => {
    const v = press({ type: 'select_option', index: 7, question: overlay.question });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.resync).toBe(true);
  });

  it('matches on the option index, not its array position', () => {
    // The wire index is server-assigned; a surface echoes it back verbatim.
    const v = askPressVerdict({
      overlay: { question: 'Q', options: [{ index: 4, label: 'Four' }], toolUseId: 't' },
      gateToolUseId: 't',
      command: { type: 'select_option', index: 4, question: 'Q' },
    });
    expect(v).toEqual({ ok: true, label: 'Four' });
  });

  it('refuses when no question is open at all', () => {
    expect(askPressVerdict({
      overlay: undefined, gateToolUseId: 't', command: { type: 'select_option', index: 0, question: 'Q' },
    }).ok).toBe(false);
  });

  it('accepts an answer from a device that could only hold part of the question', () => {
    // The regression this exists for: a Korean question is capped at 120
    // CHARACTERS by the daemon but held in a 160-BYTE firmware buffer, so it
    // reaches the device cut short. Under an exact-match gate every answer to a
    // Korean question was refused while English ones went through — a
    // length-dependent failure that reads as a flaky device, not a rule.
    const question = '이 변경을 어떤 방식으로 적용할까요? 기존 동작을 유지하면서 점진적으로 옮기는 쪽과 한 번에 교체하는 쪽 중에서 선택해 주세요. 되돌리기 비용도 함께 고려해야 합니다.';
    // Emulate the device's byte-sized buffer: strncpy to 159 bytes, then
    // utf8TrimEnd() drops the sequence the cut landed inside.
    const bytes = new TextEncoder().encode(question).slice(0, 159);
    const truncated = new TextDecoder('utf-8').decode(bytes).replace(/�$/, '');
    expect(truncated).not.toBe(question);
    expect(askPressVerdict({
      overlay: { question, options: [{ index: 0, label: '점진적으로' }], toolUseId: 't' },
      gateToolUseId: 't',
      command: { type: 'select_option', index: 0, question: truncated },
    })).toEqual({ ok: true, label: '점진적으로' });
  });
});

describe('askEchoMatches — a truncated echo still names its question', () => {
  const long = 'Which migration strategy should we use for the session store rewrite?';

  it('accepts an exact echo', () => {
    expect(askEchoMatches(long, long)).toBe(true);
  });

  it('accepts a long enough prefix', () => {
    expect(askEchoMatches(long.slice(0, 40), long)).toBe(true);
  });

  it('refuses a prefix too short to identify the question', () => {
    // A few shared leading characters are common between sibling questions
    // ("Which one…"), so a short echo is not evidence of anything.
    expect(askEchoMatches(long.slice(0, ASK_ECHO_MIN_PREFIX - 1), long)).toBe(false);
  });

  it('refuses an echo that diverges from the live question', () => {
    expect(askEchoMatches(`${long.slice(0, 40)}x`, long)).toBe(false);
  });

  it('refuses an echo LONGER than the live question', () => {
    // Direction matters: truncation only ever shortens. An echo that extends
    // past the live question is a different, longer question — typically the
    // one a grouped prompt just moved past.
    expect(askEchoMatches(`${long} And why?`, long)).toBe(false);
  });

  it('refuses a superseded question that shares a long prefix', () => {
    const q1 = 'Which migration strategy should we use for the session store?';
    const q2 = 'Which migration strategy should we use for the timeline store?';
    expect(askEchoMatches(q1, q2)).toBe(false);
  });
});

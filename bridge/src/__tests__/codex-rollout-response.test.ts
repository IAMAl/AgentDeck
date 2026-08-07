import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { locateCodexRollout, lastAgentMessageFromCodexRollout, codexTurnOutcomeFromRollout } from '../codex-rollout-response.js';

/**
 * Observed Codex response capture: codex_stop's payload rarely carries the
 * assistant text, so the daemon reads it from the rollout JSONL tail —
 * `task_complete.last_agent_message` first, else the final `agent_message`.
 * Fixtures mirror real record shapes from ~/.codex/sessions rollouts.
 */
describe('codex rollout response reader', () => {
  const SID = '019ea4a1-ae61-78f1-b420-348c1695f3d7';
  let root: string;

  const dayDir = () => {
    const dir = join(root, '2026', '07', '05');
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const writeRollout = (lines: unknown[], sid = SID) => {
    const path = join(dayDir(), `rollout-2026-07-05T10-00-00-${sid}.jsonl`);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('locates a rollout by the session uuid embedded in the filename', () => {
    const path = writeRollout([{ type: 'session_meta', payload: { id: SID } }]);
    expect(locateCodexRollout(SID, root)).toBe(path);
    expect(locateCodexRollout('deadbeef-0000-0000-0000-000000000000', root)).toBeNull();
  });

  it('prefers task_complete.last_agent_message (authoritative turn close)', () => {
    writeRollout([
      { type: 'event_msg', payload: { type: 'agent_message', message: 'mid-turn commentary', phase: 'commentary' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'final reply body' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'authoritative reply' } },
      { type: 'event_msg', payload: { type: 'token_count', info: {} } },
    ]);
    expect(lastAgentMessageFromCodexRollout(SID, root)).toBe('authoritative reply');
  });

  it('falls back to the newest agent_message when no task_complete follows', () => {
    writeRollout([
      { type: 'event_msg', payload: { type: 'agent_message', message: 'older message' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'newest message' } },
    ]);
    expect(lastAgentMessageFromCodexRollout(SID, root)).toBe('newest message');
  });

  it('returns empty for missing rollouts, malformed lines, and bad ids', () => {
    expect(lastAgentMessageFromCodexRollout(SID, root)).toBe('');
    writeFileSync(join(dayDir(), `rollout-2026-07-05T10-00-00-${SID}.jsonl`), 'not json\n{"half":', 'utf-8');
    expect(lastAgentMessageFromCodexRollout(SID, root)).toBe('');
    expect(lastAgentMessageFromCodexRollout('', root)).toBe('');
    expect(lastAgentMessageFromCodexRollout('../../etc/passwd', root)).toBe('');
  });

  /**
   * A failed turn is the case Codex never reports through a hook: it does not
   * run `Stop`, so this file is the only place the failure is observable. It
   * used to be skipped entirely, which is what left the turn spinning with its
   * cause sitting unread on disk.
   */
  describe('failed turns', () => {
    it('reports the error a task_complete carries instead of a reply', () => {
      writeRollout([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
        { type: 'event_msg', payload: {
          type: 'task_complete',
          last_agent_message: null,
          error: { message: "You've hit your usage limit.", codex_error_info: 'usage_limit_exceeded' },
        } },
      ]);
      const out = codexTurnOutcomeFromRollout(SID, root);
      expect(out.text).toBe('');
      expect(out.error).toBe("You've hit your usage limit.");
      expect(out.errorKind).toBe('usage_limit_exceeded');
    });

    it('reports a standalone error record', () => {
      writeRollout([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'error', message: 'stream disconnected', codex_error_info: 'other' } },
      ]);
      expect(codexTurnOutcomeFromRollout(SID, root).error).toBe('stream disconnected');
    });

    it('unwraps the upstream JSON body Codex nests in the message', () => {
      writeRollout([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: {
          type: 'error',
          message: JSON.stringify({ type: 'error', status: 400, message: "The 'gpt-5.6-sol' model is not supported." }),
        } },
      ]);
      expect(codexTurnOutcomeFromRollout(SID, root).error)
        .toBe("The 'gpt-5.6-sol' model is not supported.");
    });

    /**
     * The scan must stop at the turn's own opening record. Without that, a
     * failed turn — which contributes no agent_message — walked into the
     * PREVIOUS turn and returned its reply as this one's.
     */
    it('never inherits the previous turn\'s reply', () => {
      writeRollout([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'first' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'an answer from the turn before' } },
        { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'an answer from the turn before' } },
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'second' } },
        { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null,
          error: { message: 'quota exhausted' } } },
      ]);
      const out = codexTurnOutcomeFromRollout(SID, root);
      expect(out.text).toBe('');
      expect(out.error).toBe('quota exhausted');
    });

    it('still returns a successful reply unchanged', () => {
      writeRollout([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } },
      ]);
      expect(codexTurnOutcomeFromRollout(SID, root).text).toBe('done');
      expect(lastAgentMessageFromCodexRollout(SID, root)).toBe('done');
    });
  });
});

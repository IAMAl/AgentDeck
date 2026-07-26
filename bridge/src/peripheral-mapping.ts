/**
 * Turn a raw peripheral primitive (an NFC tag tap today; IR / sub-GHz codes
 * later) into one of the steering commands the daemon already speaks.
 *
 * The firmware deliberately reports *what it sensed*, never what it means —
 * meaning lives here, as user configuration, so a new physical trick never
 * needs new firmware. See docs/esp32-companion-concepts.md § Peripheral
 * primitives.
 *
 * settings.json:
 *
 *   "peripheralMappings": [
 *     { "kind": "nfc_tag", "uid": "04A1B2C3", "action": "focus",
 *       "project": "AgentDeck" },
 *     { "kind": "nfc_tag", "uid": "0455C1D2", "action": "approve" },
 *     { "kind": "nfc_tag", "uid": "04991A7E", "action": "review",
 *       "project": "Remin" }
 *   ]
 *
 * `project` selects which session the action applies to (case-insensitive
 * substring of the project name). Omit it and the action targets the session
 * that most needs a human: an awaiting one first, then a processing one.
 *
 * Unmapped taps are not an error — the daemon logs the uid so the user can
 * discover it and add a mapping.
 */

export type PeripheralActionKind = 'focus' | 'approve' | 'deny' | 'review' | 'stop';

export interface PeripheralMapping {
  kind: 'nfc_tag' | 'ir_rx' | 'subghz_rx';
  /** NFC tag uid (uppercase hex, matched case-insensitively). */
  uid?: string;
  /** IR / sub-GHz raw code. */
  code?: string;
  action: PeripheralActionKind;
  /** Case-insensitive substring of the target session's project name. */
  project?: string;
}

export interface MappingSessionView {
  id: string;
  projectName?: string;
  state?: string;
  /** Held PreToolUse gate id, when the session has one. */
  requestId?: string;
}

export interface ResolvedPeripheralAction {
  action: PeripheralActionKind;
  session: MappingSessionView;
}

/** Read + validate the `peripheralMappings` block. Unknown shapes are dropped
 *  rather than throwing: a typo in settings must not take the daemon down. */
export function parsePeripheralMappings(settings: Record<string, unknown>): PeripheralMapping[] {
  const raw = settings.peripheralMappings;
  if (!Array.isArray(raw)) return [];
  const out: PeripheralMapping[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const kind = e.kind;
    const action = e.action;
    if (kind !== 'nfc_tag' && kind !== 'ir_rx' && kind !== 'subghz_rx') continue;
    if (action !== 'focus' && action !== 'approve' && action !== 'deny'
        && action !== 'review' && action !== 'stop') continue;
    const uid = typeof e.uid === 'string' ? e.uid.trim() : undefined;
    const code = typeof e.code === 'string' ? e.code.trim() : undefined;
    if (!uid && !code) continue;
    out.push({
      kind,
      uid,
      code,
      action,
      project: typeof e.project === 'string' && e.project.trim() ? e.project.trim() : undefined,
    });
  }
  return out;
}

function matchesEvent(m: PeripheralMapping, event: { kind: string; uid?: string; code?: string }): boolean {
  if (m.kind !== event.kind) return false;
  if (m.uid) return typeof event.uid === 'string' && m.uid.toLowerCase() === event.uid.toLowerCase();
  if (m.code) return typeof event.code === 'string' && m.code.toLowerCase() === event.code.toLowerCase();
  return false;
}

/** Awaiting outranks processing outranks anything else — the same "who needs a
 *  human" ordering the knob and the strip use. */
function pickSession(
  sessions: MappingSessionView[],
  project: string | undefined,
): MappingSessionView | undefined {
  const pool = project
    ? sessions.filter((s) => (s.projectName ?? '').toLowerCase().includes(project.toLowerCase()))
    : sessions;
  return pool.find((s) => (s.state ?? '').includes('awaiting'))
    ?? pool.find((s) => s.state === 'processing')
    ?? pool[0];
}

/**
 * Resolve a peripheral event to an action + target session, or undefined when
 * nothing is mapped (or the mapped project has no live session).
 */
export function resolvePeripheralAction(
  event: { kind: string; uid?: string; code?: string },
  mappings: PeripheralMapping[],
  sessions: MappingSessionView[],
): ResolvedPeripheralAction | undefined {
  const mapping = mappings.find((m) => matchesEvent(m, event));
  if (!mapping) return undefined;
  const session = pickSession(sessions, mapping.project);
  if (!session) return undefined;
  return { action: mapping.action, session };
}

/** The daemon command a resolved action becomes. Approve/deny prefer a held
 *  gate (permission_decision) and otherwise drive the live prompt — the same
 *  fallback pair every AgentDeck steering surface uses. */
export function commandForAction(
  resolved: ResolvedPeripheralAction,
): Record<string, unknown> | undefined {
  const { action, session } = resolved;
  switch (action) {
    case 'focus':
      return { type: 'focus_session', sessionId: session.id };
    case 'review':
      return { type: 'review_run', sessionId: session.id };
    case 'stop':
      return { type: 'session_command', sessionId: session.id, command: { type: 'interrupt' } };
    case 'approve':
      return session.requestId
        ? { type: 'permission_decision', requestId: session.requestId, decision: 'allow' }
        : { type: 'select_option', sessionId: session.id, index: 0 };
    case 'deny':
      return session.requestId
        ? { type: 'permission_decision', requestId: session.requestId, decision: 'deny' }
        : { type: 'session_command', sessionId: session.id, command: { type: 'escape' } };
    default:
      return undefined;
  }
}

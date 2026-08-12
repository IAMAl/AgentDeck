/**
 * Registry for encoder action IDs (Stream Deck+ E1–E4).
 * Each action module registers its IDs here so cross-cutting features
 * (the offline banner) can address every encoder LCD.
 *
 * SD+ encoder roles (E2/E3 rotate cycles both → 5h → 7d → session; press refreshes):
 *   E1 = volume                      — utilityIds (UUID kept as `utility-dial`)
 *   E2 = Claude usage gauge          — optionIds  (UUID kept as `option-dial`)
 *   E3 = Codex usage gauge           — usageIds   (UUID kept as `iterm-dial`)
 *   E4 = launcher                    — launcherIds
 */
export const encoderRegistry = {
  utilityIds: [] as string[],   // Volume dial (E1)
  optionIds: [] as string[],    // Claude usage dial (E2)
  usageIds: [] as string[],     // Codex usage dial (E3)
  launcherIds: [] as string[],  // Launcher dial (E4)
  // Option/permission selection dial — no fixed slot. Unlike the four above it
  // is opt-in: the user assigns it to whichever encoder they want, so it never
  // displaces a usage gauge the way the retired takeover did.
  optionSelectIds: [] as string[],
};

// ─── Daemon connection state (shared with all four encoder dials) ────────
// The encoder OFFLINE banner (renderOfflineTouchStrip) is an all-or-nothing
// 800px design across 4 encoders, and its messaging ("launch the app") is only
// meaningful when the daemon WS is truly down. Dials must gate the banner on
// THIS flag — set only on real connect/disconnect — never on session-level
// `currentState === DISCONNECTED`, which flips transiently during multi-session
// switching while the daemon stays connected (mirrors the keypad's policy in
// session-slot-button.ts). Kept separate from that module's daemonConnected,
// which has keypad-only side effects (clears sessions, exits detail view).
let _daemonConnected = false;
export function setEncoderDaemonConnected(v: boolean): void { _daemonConnected = v; }
export function isDaemonConnected(): boolean { return _daemonConnected; }

// ─── Option takeover ─────────────────────────────────────────────────────
// The encoder option-TAKEOVER (E1–E4 commandeered for AWAITING option/permission
// selection) was retired in the Phase 2 SD+ redesign, then restored here in a
// narrower form: it now fires ONLY when no dedicated Answer Prompt dial is
// placed. A user who assigns that action keeps the old opt-in behaviour and
// nothing yields; a user who keeps the four default dials gets them lent to the
// picker for the duration of a prompt and handed straight back. That "dedicated
// wins" rule is what keeps the two designs from fighting over the same LCDs,
// which is why the pre-7e10292f version needed cross-module callback cycles.
//
// Only the RESTORE direction needs a callback: option-select-dial paints and
// reads input directly, but asking the four dials to repaint their own faces
// would close an import cycle (dial → option-select-dial → dial).
let _optionTakeover = false;
export function isOptionTakeoverActive(): boolean { return _optionTakeover; }
export function setOptionTakeoverActive(v: boolean): void { _optionTakeover = v; }

const _restoreCallbacks: Array<() => void> = [];
/** Each default dial registers its own repaint here at init. */
export function registerTakeoverRestore(fn: () => void): void { _restoreCallbacks.push(fn); }
/** Call only AFTER clearing the flag — the callbacks gate on it. */
export function fireTakeoverRestore(): void {
  for (const fn of _restoreCallbacks) {
    try { fn(); } catch { /* one dial's repaint must not strand the others */ }
  }
}

// Physical column per encoder action id. The picker is laid out in 800-space and
// each dial paints the window at its own column, so registration order is not a
// usable substitute — two dials at columns 0 and 3 are not a 400px strip.
const _encoderColumns = new Map<string, number>();
export function registerEncoderColumn(id: string, column: number | undefined): void {
  if (typeof column === 'number') _encoderColumns.set(id, column);
}
export function forgetEncoderColumn(id: string): void { _encoderColumns.delete(id); }
export function encoderColumnOf(id: string): number | undefined { return _encoderColumns.get(id); }

/** The four default dials, left to right. Falls back to slot order for a dial
 *  whose payload carried no coordinates. */
export function takeoverTargetIds(): string[] {
  const ordered = [
    ...encoderRegistry.utilityIds,
    ...encoderRegistry.optionIds,
    ...encoderRegistry.usageIds,
    ...encoderRegistry.launcherIds,
  ];
  return ordered
    .map((id, i) => ({ id, col: _encoderColumns.get(id) ?? i }))
    .sort((a, b) => (a.col - b.col) || 0)
    .map((e) => e.id);
}

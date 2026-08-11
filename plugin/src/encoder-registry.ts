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

// The encoder option-TAKEOVER (E1–E4 commandeered for AWAITING option/permission
// selection) was retired in the Phase 2 SD+ redesign: E2/E3 now permanently show
// Claude/Codex usage, and option/permission selection lives on the keypad detail
// view (session-slot). The takeover cross-module callback cycles were removed
// along with encoder-takeover.ts. The voice-text takeover that also borrowed
// these LCDs went with the Voice dial.

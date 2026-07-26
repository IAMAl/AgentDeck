# ESP32 companion concepts — T-Embed CC1101 and T-Display-S3-Pro

This is a concept study for the two **Evaluation** boards in the [hardware compatibility sheet](hardware-compatibility.md): what role each would play if promoted to Shipping. Nothing in this document is implemented and nothing here is a compatibility claim. The premise is deliberate: neither board should be a port of the existing dashboard — each earns its place by doing something the current fleet cannot.

The single most important fact shaping both concepts: **the daemon already speaks a complete steering vocabulary** on port 9120 — `focus_session`, `navigate_option`, `select_option`, `session_command{escape|interrupt|respond}`, `review_run`, `permission_decision` (`bridge/src/daemon-server.ts`). Today only the Stream Deck plugin, the Ulanzi plugin, and the ips10 touch mosaic use it. Core steering from a new device therefore needs **no new command types** — only a device that can drive the existing ones.

## T-Embed CC1101 — "Companion Knob"

> **Status (2026-07-25): the docked steering-knob mode below is implemented and hardware-verified** — PlatformIO env `t_embed`, spec-sheet status Shipping, WiFi OTA verified (`agentdeck esp32-ota t_embed`). Steering is verified against the Node daemon; the Swift-daemon steering pass, the portable pager (incl. BLE phone relay), voice, and the peripheral primitives remain future phases, and their gap rows below stay live.

The compatibility sheet already states the thesis: the T-Embed is the only unit in the fleet with a rotary encoder and the only bidirectional-input candidate — every Shipping board is output-only apart from touch. A rotary encoder is exactly the shape of the existing steering vocabulary: rotate = move a cursor, press = commit, long-press = back. The board is a **dual-mode companion**: docked on the desk it is a steering knob; unplugged it is a battery pager you carry around the house.

### Interaction grammar (both modes)

The grammar is the Stream Deck session-centric two-level UX ([streamdeck-layout](streamdeck-layout.md): list level = enter a session, detail level = state-dependent commands, BACK = leave) translated to an encoder. It reuses the `buildSessionDeck` concept from `@agentdeck/shared` rather than inventing a new layout model.

| Input | List level | Detail level (focused session) |
|---|---|---|
| Rotate | Cycle sessions | Move option/command cursor (`navigate_option`) |
| Short press | Enter session (`focus_session`) | Commit (`select_option` / state command) |
| Long press | — | BACK / cancel (`session_command{escape}`) |

Detail-level commands are state-dependent, mirroring the Stream Deck grammar: an **awaiting** session exposes the real parsed options (approve/deny, AskUserQuestion choices); a **processing** session exposes STOP (`interrupt`); an **idle** session exposes GO ON / REVIEW (`review_run`) — making the knob the minimum viable steering device for a desk without a Stream Deck.

### Mode A — docked steering knob

USB-powered on the desk. The 1.9″ 320×170 panel shows the focused session's detail (agent glyph, state, current tool or question, elapsed time). The 8× WS2812 ring is a session-status ring — up to eight sessions, one LED each, colored with the semantic status tokens. Per the design system rule, **only amber awaiting animates**; kelp and coral stay static. The ring makes the knob glanceable from across the room even though the panel is small.

### Mode B — portable pager

On its 1300 mAh battery the board roams the local WiFi. The panel sleeps; the ring and speaker stay armed. When a session enters a genuine response-wait (derived from the awaiting fields already present in `sessions_list` — `question`, `promptType`, `options`; no new event needed), the ring pulses amber and the speaker plays a short chime. The holder answers on the spot with the encoder: rotate through the options, press to commit. Power discipline follows the display-sleep contract (off must be dark, min must stay legible; heartbeat re-sync guards against a lost wake edge), with a relaxed WS keepalive interval while asleep. The BQ27220 fuel gauge reports battery percentage through `device_info`/status so the dashboard's downstream rail can show charge state.

**Phone-paired transport (BLE)**: portable range today is bounded by the board's own WiFi association. A second transport — a BLE GATT link to the iOS/Android AgentDeck app, with the phone relaying frames to the daemon over its existing paired WS — buys three things: **battery** (BLE idle draw is a fraction of WiFi's, and idle draw is what actually decides pager standby time), **roaming that follows the phone** instead of AP coverage, and **pairing UX inside the app** instead of `agentdeck wifi-setup`. The steering command set is tiny (a cursor and a commit), so it fits BLE comfortably. Honest boundary: this is not internet-wide remote control — the phone must still reach the daemon on the local network; AgentDeck has no cloud relay and this concept does not add one. The app-side relay also needs an [appstore-feature-matrix](appstore-feature-matrix.md) tier decision before implementation touches the apps.

### Mode C — voice remote (staged)

- **Stage 1 (no new audio code)**: the speaker doubles as the pager chime, and press-and-hold becomes a push-to-talk trigger for the host-side voice pipeline. Note the routing gap: the `voice {start|stop|cancel}` command is currently handled by the per-session bridge only, not `daemon-server` — daemon routing must be added before a daemon-attached device can trigger it.
- **Stage 2 (on-device wake word)**: the dormant `esp32/src/audio/wake_word.*` path (`BOARD_HAS_AUDIO`, currently defined in no env) is the revival candidate, using the onboard mic for local inference only — hands-free arming for stage 3 without streaming anything by default.
- **Stage 3 (handheld AI speaker)**: press-and-hold (or wake word), speak a question, release. The board streams mic audio to the daemon over a **binary WS side-channel** (the ~200-byte text outbox is explicitly not this path; PCM16 mono at 16 kHz is well within WiFi budget), host-side STT turns it into a prompt for the focused session — or a dedicated lightweight ask-agent when nothing is focused — and the reply comes back as host-side TTS audio streamed to the speaker, with the reply text mirrored on the panel. The board contributes exactly a microphone, a speaker, and a button; every heavy stage (STT, agent, TTS) stays on the host. Cost-sensitive defaults apply end to end: on-host local engines by default, API engines opt-in.

### Peripheral primitives — ship the floor, explore the ceiling

The NFC, IR, and sub-GHz radios are neither parked nor given bespoke features up front. Instead the firmware ships **raw primitives** behind one generic peripheral surface, so exploration happens on real captured data instead of speculation:

- **Capability advertisement**: `device_info` gains a capabilities list (`nfc`, `ir_rx`, `ir_tx`, `subghz_rx`, `audio`, `battery`) so the daemon and dashboard know what a board can do without board-name special-casing.
- **`peripheral_event` (device→daemon)**: one frame shape for everything the board senses — `{kind:"nfc_tag", uid}`, `{kind:"ir_rx", protocol, code}`, `{kind:"subghz_rx", freq, rssi, code}`. Events surface in the dashboard (diag/timeline) and are mappable to **existing** commands through user config: tag X → `focus_session`, remote button Y → `select_option`, tag Z required before `permission_decision{allow}`.
- **`peripheral_command` (daemon→device)**: the actuation mirror — `{kind:"ir_tx", code}` replay of a code the user previously captured, plus ring/chime test frames.

Applications then become config mappings rather than firmware work: NFC tags as **project bookmarks** (tap to focus) or as a **physical second factor** for dangerous permission approvals; any cheap 433 MHz remote as extra AgentDeck buttons anywhere in the house; a captured IR code replayed when a session completes ("turn the desk lamp green"). Boundary: **sub-GHz stays receive plus replay-of-own-captured-codes only** — no arbitrary transmit, both for radio-band compliance and because scan/capture already covers the exploration value.

The identity to protect: this board is not another display. It is the fleet's only *input* device — and with these primitives its only sensor/effector — and every design choice should defend that.

### Refinement directions (2026-07-25, from external ideation)

A ten-concept external study of the T-Embed form factor ("AI ORBIT CONTROLLER") was reviewed against this architecture. What it validates, what it adds, and what stays out of scope:

**Adopted — maps onto existing wiring:**

- **INTENT (autonomy dial)** — the strongest addition. "Click-then-rotate adjusts how boldly the agent acts" maps directly onto machinery AgentDeck already has: Claude Code **permission modes** (default / acceptEdits / plan / bypassPermissions) are switchable today via the routable `switch_mode` command (the Shift+Tab convention), **effort level** already travels in the state stream, and the model choice already has a daemon-side answer in the APME Pareto **Recommend**. A detail-level "Autonomy" menu entry — rotate through mode/effort steps, press to apply — turns the knob into the physical steering wheel for *how* an agent works, not just *what it does next*. No new protocol; managed PTY sessions only at first (observed sessions can't switch modes).
- **RESUME (timeline scrubbing)** — rotate to scrub the focused session's milestone history. The daemon already serves exactly this via `query_session_timeline` (session-scoped `timeline_history` backfill); the knob adds a read-only "scrub" sub-view in detail mode. Checkpoint *jumping* stays out (no such primitive), but scrub + read is a natural encoder gesture.
- **WHISPER (voice capture → next action)** — refines voice Stage 3: a captured utterance doesn't have to open a live Q&A; routed through the existing turn-end **directive queue** (`send_prompt`), a spoken thought becomes the session's next instruction. "Speak → pick target session with the dial → queued" is the AgentDeck-native version of the study's idea-inbox.
- **RELAY (work-token framing)** — not a feature but the right *mental model* for the grammar we shipped: STOP = take the baton, options/approve = answer and hand it back, Go on = hand the baton to the agent. Worth adopting in copy and docs.
- **Screen discipline** — the study's four-line rule matches this panel: *who is working, what they're doing, how far along, what I can do*. The list-level card already approximates it; treat it as the explicit acceptance test for every future knob screen.
- **ORBIT (radio-channel switching)** — validates the shipped list level (rotate = cycle sessions, ring = fleet state). One deviation stays deliberate: "needs human" pulses **amber**, not red — semantic status colors are a design-system invariant.

**Noted for later phases:**

- **PROBE** (environmental sensing via Grove/GPIO) folds into the peripheral-primitives plan — sensors would ride the same `peripheral_event` frame; no bespoke mode.
- **TUNE** (continuous generative-parameter tuning) — the encoder-as-continuous-controller insight is sound, but AgentDeck has no generative-parameter surface; the INTENT dial is its coding-agent translation.

**Out of scope (not AgentDeck's product):** TURN (meeting facilitation), COMPASS (personal direction), SIGNAL (presence totem) — desirable products, different product. Recorded so they are not re-litigated here.

Hardware caveat: the study describes the **base** T-Embed (7-LED ring, dual mic, 1200 mAh, no radios). The on-hand unit is the CC1101 variant — 8-LED ring, single mic + speaker, 1300 mAh, plus the NFC/IR/sub-GHz set — so counts and peripherals in the spec sheet stay authoritative.

## T-Display-S3-Pro — "Tide Ticker"

The 2.33″ 480×222 wide strip is the wrong shape for a terrarium and the right shape for a **ticker**: a always-on strip below the monitor or in front of the keyboard, showing the numbers a working session makes you tab away to check. It is a stationary desk fixture (USB-powered; the 470 mAh cell only bridges cable swaps).

Three pages, cycled with the three physical hardware buttons (reusing the TC001 `matrix_buttons` debounce/short-long idiom):

- **Usage** — Claude and Codex quota windows (5 h primary, 7 d secondary) as full-height gauges with reset countdowns: the permanent large-format version of the Stream Deck E2/E3 dials. Gauges follow the established gauge grammar: full fill, sharp stage colors, white numerals.
- **APME** — the composite score trend and the current Pareto **Recommend** verdict (which model for which category), resident on the desk instead of inside the dashboard's Recommend tab. Known gap: `apme_*` events are stripped from the ESP32 forward filter today, so this page needs either a compact board-facing summary event or a whitelist extension (see gap table).
- **Ticker** — a one-line timeline milestone ticker following the glance rules: card detail shows milestones, live tool activity belongs to state, task rows are excluded from glance surfaces.

Touch adds drill-down, not navigation: tap a gauge for the exact reset time, tap the recommend row for the runner-up and rationale. The **LTR-553 ambient light sensor** makes this the first board where the display-sleep contract gets a sensor input — brightness follows room light and the strip dims itself at night, handled entirely locally (no protocol change). Note the V1.1 backlight constraint from the spec sheet: constant-current drive with 16 levels, `USING_DISPLAY_PRO_V1` must stay undefined on the on-hand units, so the dim curve is quantized.

**Desk-set pairing**: when the Companion Knob focuses a session, the Ticker receives the focus broadcast and highlights that session's usage and eval numbers — the two boards compose into one steering-plus-instrumentation desk set.

**Exploratory**: the optional GC0308 camera could provide on-device presence detection for display wake (never streamed, never stored — on-device only as a hard privacy line). Deferred regardless: the camera's SCCB lines share the I2C bus with touch, the PMU, and the light sensor, so capture would degrade touch responsiveness.

## Promotion gaps — Evaluation → Shipping checklist

What has to exist before either concept runs. This is the implementation session's checklist, not a design open question.

| Gap | Where | Needed by |
|---|---|---|
| ~~Serial has no device→daemon command channel~~ — closed 2026-07-26 (Node): `handleSerialLine` forwards a command passlist into the same pipeline as WS; Swift twin still device_info-only | `bridge/src/esp32-serial.ts` + Swift twin | Done on Node; Swift pending |
| **NEW capability (2026-07-26): observed AskUserQuestion answered from devices** — the daemon types the selection into the session's own terminal (Down×index + Enter), located by controlling tty: tmux pane via `send-keys`, else iTerm2 via AppleScript. No hold, no timeout, nothing auto-proceeds if the terminal is unreachable. Two swallow-bugs fixed en route: the OpenClaw gateway consumed bare session-scoped `select_option`, and serial steering frames were dropped. Node daemon only (App Store Swift daemon spawns no subprocesses — CLI-tier). | `bridge/src/observed-inject.ts` | Knob + Focus Strip (shipped) |
| ~~`prepareForSerial` strips what the knob needs~~ — corrected 2026-07-25: both daemons already forward per-session `question`/`promptType`/`options`; only `requestId` is missing (neither daemon sends it), so approve/deny run the ips10 fallback (`select_option(0)`/`escape`) until it lands | `bridge/src/esp32-serial.ts` + Swift twin | Knob (works today; requestId later) |
| Firmware outbound frames capped at ~200 bytes (`OUTBOX_LEN`) | `esp32/src/net/ws_client.cpp` | Any `respond`/`send_prompt`-class command |
| ~~No LVGL encoder indev~~ — closed 2026-07-25: the knob consumes encoder events directly (`src/input/encoder.cpp` ISR decode → `ui/knob/` grammar); no LVGL indev/`lv_group` was needed | `esp32/src/ui/knob/` | Knob (done) |
| `device_info` has no capability advertisement beyond OTA — battery, NFC, audio cannot be announced | `shared/src/protocol.ts` | Pager battery reporting, peripheral primitives, voice |
| No `peripheral_event` / `peripheral_command` frames — NFC, IR, and sub-GHz have no protocol representation in either direction | `shared/src/protocol.ts` + daemon mapping config | Peripheral primitives |
| No BLE link on either end — firmware exposes no GATT service, and the mobile apps have no BLE central/relay role (plus the app-side relay needs a product-tier decision) | `esp32/` + `apple/` / `android/` | Phone-paired portable transport |
| No audio streaming channel (text-frame WS only, ~200 B outbox) and no daemon-side STT→prompt / reply→TTS routing | `esp32/src/net/` + daemon voice pipeline | AI speaker (Mode C stage 3) |
| `apme_*` events stripped by the ESP32 forward filter | `SERIAL_FORWARDED_EVENTS` in `shared/src/protocol.ts` | Ticker APME page |
| `voice` command is session-bridge-only, not routed by `daemon-server` | `bridge/src/index.ts` vs `bridge/src/daemon-server.ts` | Voice stage 1 |
| New-board bring-up is a ~10-step compile-time checklist (board header, env, partitions, `display.cpp`, `main.cpp`, two duplicated board-string ladders, OTA list, docs) | `esp32/` | Both boards |
| ~~No factory-firmware backup for the T-Display-S3-Pro~~ — closed 2026-07-25: 16 MB image captured and spot-verified | [`esp32/backups/MANIFEST.md`](../esp32/backups/MANIFEST.md) | Done |

Design-system constraints carry over unchanged: status colors are semantic and only amber awaiting animates ([DESIGN.md](../DESIGN.md)); brand marks come from the generated masks, never redrawn; both boards would join the counted-surfaces derivation only at promotion time, which is when their spec-sheet rows change status and the surface matrix — not this document — becomes the source of truth.

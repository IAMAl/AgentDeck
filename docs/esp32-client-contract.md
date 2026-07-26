---
id: spec.esp32-client
title: ESP32 Client Contract
description: The wire contract an external or forked display-only ESP32 client must honour — inbound events and device_info frames.
category: Specs
locale: en
canonical: true
status: stable
owner: Firmware maintainers
reviewed: 2026-07-26
revision: 2026-07-26
source_of_truth: docs/esp32-client-contract.md
validators: [bash scripts/sync-xteink-eink-dashboard.sh --check]
---
# AgentDeck ESP32 Client Contract

The wire contract a **display-only AgentDeck client** must honour to render live agent
state and (optionally) steer sessions. This is the human-readable subset of the protocol
that a board firmware implements; the machine-readable source of truth is
[`shared/src/protocol.ts`](../shared/src/protocol.ts), and the reference first-party
implementation is [`esp32/src/net/protocol.cpp`](../esp32/src/net/protocol.cpp).

**Who this is for.** First-party `esp32/` boards already implement the full contract. This
doc exists so a *third-party or forked* firmware — today the **XTeink X3/X4** (an external
CrossPoint Reader fork, `crosspoint-agentdeck`; see
[hardware-compatibility.md](hardware-compatibility.md) footnote ⁷) — can port a minimal,
correct client without reading the whole 39KB reference parser. The X3/X4 fork's `src/agentdeck/`
is explicitly a *"TRIMMED port of AgentDeck esp32/src/net/protocol"*; this is the contract
it ports **from**. When the events or `device_info` fields below change, that port must be
re-synced — see [esp32.md § Downstream client port sync](esp32.md#downstream-client-port-sync).

There is **no C/C++ codegen** for this contract. `pnpm generate-protocol` emits Swift and
Kotlin only; quicktype's C++ output (exceptions, `std::string`, nlohmann/json) is unusable
on a no-PSRAM RISC-V target that parses with ArduinoJson. Even the first-party `esp32/`
firmware hand-writes its parser. Codegen is not the drift guard — this doc plus the
port-sync discipline is.

## Transport

- **WiFi WebSocket** to the daemon on **port 9120** (`BRIDGE_WS_PORT`), discovered via mDNS
  `_agentdeck._tcp`. Reconnect with backoff (`RECONNECT_BACKOFF_MS` ladder 1→2→4→8s). Also
  the fallback UDP-broadcast discovery on 9121 that the X3 port carries.
- **USB Serial JSON** (115200, newline-framed) is the other first-party transport. A
  WiFi-only client (X3/X4, InkDeck) can skip serial, but then it is only registrable once it
  emits `device_info` over WS (see below).
- Frames are single-line JSON. Reject anything larger than `PROTOCOL_MAX_MSG_BYTES` before
  feeding an elastic JSON document — an unbounded `sessions_list`/`timeline_history` will
  otherwise fragment/exhaust the heap on no-PSRAM boards.

## Inbound — messages the client parses

Dispatch on the top-level `"type"`. The forwarded sets are defined in `protocol.ts`
(`DISPLAY_FORWARDED_EVENTS` ⊂ `SERIAL_FORWARDED_EVENTS`).

**Minimum viable client (the X3's "M2" subset):**

| `type` | Purpose |
|---|---|
| `state_update` | Per-session state (idle / processing / awaiting_* …). The primary render input. |
| `sessions_list` | Full session roster — id, agent type, state, label. Each session also carries `activity`: a clean one-liner ("Editing auth.ts") from the shared activity pipeline — **render this, not the raw `currentTool`** ("Bash"). Both the Node bridge and the in-process Swift daemon now populate it; fall back to `currentTool`/`currentTask`/`goal` only when `activity` is empty. A card with 2–3 available lines may compose the concise `activity/currentTask` with the richer `goal`, but must do so in a bounded buffer on no-PSRAM boards. Sessions with a recent milestone also carry the daemon-computed `lastEventText` (≤99 bytes, the newest chat/task row text), optional `lastEventTask` (≤39 bytes, resolved enclosing-task label) and `lastEventHm` ("HH:MM" host-local) — the TIMELINE-parity "what happened last" line; card-style surfaces should prefer `lastEventHm + lastEventTask + lastEventText` over reconstructing it from the on-device timeline ring (which starts empty after every reboot). Absent fields are omitted, never empty strings. |
| `usage_update` | Subscription / rate-limit gauges (Claude 5h, Codex, Antigravity, …). |
| `connection` / `connected` | Connect/disconnect ack. Actual link state is tracked by WS event callbacks; these are logged for diagnostics. |

**Fuller set — parse if you render it, otherwise accept-and-ignore is acceptable:**

| `type` | Purpose |
|---|---|
| `timeline_event` | Incremental activity-log row. `ts` is epoch-ms; entries also carry `localHm` = daemon host-local "HH:MM" (both daemons stamp it now) — RTC-less clients render `localHm` for the wall time rather than deriving from `ts` in UTC. |
| `timeline_history` | Backfill of recent timeline rows on (re)connect. A reply to `query_session_timeline` includes top-level `sessionId`; constrained clients may replace their mixed live ring with that session-specific batch so unrelated busy sessions cannot evict the requested Detail rows. |
| `display_state` | Host display on/off + optional `dim {enabled, mode, level}`. Absent `dim` ⇒ legacy full-off. Level is percent 1–100 → scale to the board's backlight domain, floored at 1. |
| `wifi_provision` | Credentials pushed over serial (USB provisioning flow). |
| `set_orientation` | `landscape` bool; portrait↔landscape toggle. |
| `device_info_request` | Reply with `device_info` (see below). X3/X4 already announce `device_info` on initial connect; request/reply parity remains recommended for host diagnostics. |

A display-only client may ignore the OTA frames (`esp32_ota_begin/chunk/end/abort`) unless
it opts into WiFi OTA with a dual-OTA partition table. The XTeink fork opted in as of its
build 88aaf098 (`src/agentdeck/ota_ws_receiver.*`): it consumes OTA frames *before* its
filtered protocol parser (an ArduinoJson filter would silently drop the base64 `data`
payload), streams chunks to an SD cache, and flashes via its raw-partition path instead of
the Arduino `Update` class.

## Outbound — messages the client emits

### `device_info` (identity + capability announcement)

Emitted on connect and in reply to `device_info_request`, over **both** transports.
`device_info.board` is the **SSOT match key** the daemon and `agentdeck esp32-ota` use to
route to a board; a client that never emits it never appears on the dashboard. Fields (from
`sendDeviceInfo`, `esp32/src/net/protocol.cpp`):

| Field | Notes |
|---|---|
| `board` | Canonical wire string, underscore convention. First-party: `ulanzi_tc001`, `inkdeck`, `ttgo_t_display`, `esp32_c6_147`, `round_amoled`, `86box`, `ips_10`, `ips_35`, `t_embed`, `t_display_pro`. External CrossPoint fork: `xteink_x3`, `xteink_x4` (one firmware, runtime-detected). Registration accepts **any** board string (the Node daemon coerces only a *missing* field to `unknown`); a board needs an `ESP32_OTA_BOARDS` entry **only** to be OTA-targetable by a short *alias* — canonical board strings and IPs pass through unchanged, which is how the fork boards are targeted (`agentdeck esp32-ota xteink_x4 --firmware <bin>`; no `esp32/` pio env, so `--build` does not apply). |
| `version` | `FIRMWARE_VERSION`. |
| `buildHash` | `GIT_SHA` — the authoritative deploy-verification field (`version` alone can't distinguish a stale flash). |
| `buildEpoch` | Build timestamp (uint32). |
| `protocolRevision` | `PROTOCOL_REVISION`. |
| `wifiConfigured` / `wifiConnected` | Provisioning + link state. `ip` when connected. |
| `otaSupported`, `otaSlotCount`, `otaSlotSize`, `otaFreeSketchSpace`, `otaReason` | OTA capability. `otaReason` only when unsupported. |
| `timelineCount`, `sessionCount`, `usageFiveH`, `processingCount` | Debug aids — let a host-side probe (`daemon /devices`) distinguish "data never parsed" from "render gating" without stealing the serial port. |

### Command frames (steering — optional)

A client with buttons must derive controls from the wire payload, never merely from an
`awaiting_*` state:

- **Device approval gate** (`requestId` present) → render exactly Allow/Deny and send
  `{"type":"permission_decision","requestId":"<id>","decision":"allow|deny"}`.
- **Managed PTY prompt** → first send `{"type":"focus_session","sessionId":"<sid>"}`.
  Render options only after a `state_update`/`prompt_options` whose `sessionId` (or stamped
  `focusedSessionId` for backward-compatible `prompt_options`) matches that session.
  `navigable:true` uses `{"type":"select_option","index":<wire-index>,"sessionId":"<sid>"}`;
  non-navigable options use `{"type":"respond","value":"<option.shortcut>"}`.
- **Observed prompt without `requestId`** → display-only “respond in terminal.” Hook
  observation does not expose the terminal's complete choice list, so clients must not
  synthesize Approve/Deny (or Yes/No/Always), emit `select_option`, or map Deny to a delayed
  `escape`.
- Keep the decision view open until a daemon event confirms the state transition; do not
  make a queued/no-op command appear successful optimistically.
- `{"type":"query_session_timeline","sessionId":"<sid>"}` requests a session's Detail
  timeline on demand (glance-surface backfill).

## Relationship to the reference implementation

- First-party boards: [`esp32/src/net/protocol.cpp`](../esp32/src/net/protocol.cpp) (full
  parser + `sendDeviceInfo` + OTA).
- X3/X4 port: `crosspoint-agentdeck` `src/agentdeck/{ws_client,protocol,mdns_discovery,udp_discovery,agent_state,agent_commands}.*`.
  It emits `client_register` plus `device_info` on connect; `display_state`/`set_orientation`
  remain optional accept-and-ignore messages for this reader activity.
- Change discipline: edits to `DISPLAY_FORWARDED_EVENTS`/`SERIAL_FORWARDED_EVENTS` in
  `protocol.ts` or to the `device_info` field list must be reflected into both the
  first-party parser and the X3 port. See the port-sync sections in
  [esp32.md](esp32.md#downstream-client-port-sync) (AgentDeck side) and the fork's
  `.skills/SKILL.md` (fork side).

## Pull sync (optional, 2026-07-26) — wake-sync-sleep battery clients

The HTTP counterpart to the WS live mode, for clients that deep-sleep between
syncs (XTeink X3/X4 on battery). Types: `shared/src/protocol.ts` § Card Feed
Pull Sync; server: `bridge/src/card-feed.ts` + the daemon routes (Node daemon
only today — the Swift in-process daemon does not serve these routes yet).
Always-powered clients keep using WS; a dual-mode client uses WS while docked
and pull while on battery.

- **`GET /feed`** (daemon port 9120) → `CardFeedResponse`: one `FeedCard` per
  session (`cardId: "session:<id>"`, body = the same `SessionInfo` shape as
  `sessions_list`), plus `serverTime`/`serverHm` (clock re-anchor for drifty
  RTCs), and `nextPullSec` — the daemon's suggested sleep interval (3600 idle /
  900 when any session is mid-turn or awaiting). Devices may clamp but should
  not poll faster on battery.
- **Per-card `actionClass`** decides offline behaviour: `live` (permission
  gates, awaiting prompts — grey out offline, `expiresAt` TTL, never answerable
  from a stale cache), `day` (M7 card modules — answers queue in the device
  outbox; no producer yet), `info` (read-only rows; show sync age).
- **`POST /outbox`** → `OutboxPushRequest` (`{board, decisions[]}`), answered
  with per-decision results **in request order**. The device deletes every
  acknowledged decision regardless of status — `expired`/`rejected`/
  `unknown_card` are terminal, not retryable. Validity is checked against live
  state: a `permission_decision` applies only while its gate is still held; an
  option decision applies only while the session is still awaiting **and** the
  echoed `question` matches the current one (an hour-old index must never press
  a newer prompt).
- **Auth**: same as `/apme` — local connections free, LAN needs the pairing
  token as `?token=` (devices hold it from provisioning; `/health` exposes it).

## Peripheral primitives (optional, 2026-07-25)

Boards with sensors beyond their panel may additionally:

- Advertise `capabilities?: string[]` in `device_info` (e.g. `"battery"`, `"nfc"`, `"audio"`) plus battery telemetry (`batteryPercent`/`batteryCharging`/`usbPowered`, and `batteryDiag` when the gauge fails). Display-only clients may omit all of these.
- Emit `peripheral_event` (device → daemon) for raw sensing: `{type:"peripheral_event", board, kind:"nfc_tag"|"ir_rx"|"subghz_rx", uid?|code?/protocol?|freq?/rssi?}`. The daemon logs and relays it to dashboard clients; meaning (tag → focus/approve) is daemon-side mapping config, never firmware policy. This frame is only deliverable over WiFi WS today — the daemon's serial path parses `device_info` only.

Neither is required for a display-only client; the XTeink fork ignores both.

## Voice (optional, 2026-07-26)

A board with a microphone and/or an amplifier may take part in the voice round
trip. Both halves are opt-in and gated on advertised capabilities: `"audio"` for
capture, `"audio_out"` for playback. A client that advertises neither is never
sent audio.

- **Capture (device → daemon)**: `{"type":"voice_begin","board","sampleRate":16000,"sessionId"}`, then the PCM16LE samples, then `{"type":"voice_end","durationMs","cancel"}`. The daemon transcribes the utterance on-device and routes the text to `sessionId` as a prompt, then answers `{"type":"voice_result","text","sessionId","delivered","via?","deliverReason?"}`. **Render `delivered:false` differently from success** — a transcript the daemon could not deliver must not look like one that arrived.
- **Playback (daemon → device)**: `{"type":"audio_play_begin","sampleRate","durationMs","text"}`, then the PCM16LE samples, then `{"type":"audio_play_end"}`. Frames are paced at roughly playback speed, so a ring buffer of a couple of seconds is enough; the daemon never sends a whole reply at once. `{"type":"voice_reply_skipped"}` means the turn finished with nothing worth reading aloud.
- **How the samples travel depends on the transport.** Over WebSocket they are binary frames. Over serial — which is line-delimited JSON — the same samples are base64-encoded inside `{"type":"audio_chunk","d":"…"}` (device → daemon) and `{"type":"audio_play_chunk","d":"…"}` (daemon → device), because raw PCM contains newlines and would tear the framing for every other reader of that port. Do not mix the two forms on one connection.
- **Serial audio needs RX headroom.** A 16 kHz mono reply is ~44 KB/s once base64-encoded, and a client whose network task blocks (an in-progress WebSocket reconnect is the usual cause) will overflow a small RX ring and lose whole lines — silently, if it discards lines that do not start with `{`. Size the ring for your worst stall, and park the radio while serial is the transport.

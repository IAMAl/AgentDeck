---
id: validation.ulanzi-plugin
title: Ulanzi Plugin Verification
description: How to verify the D200H plugin without hardware or Ulanzi Studio, and what the hardware pass adds.
category: Engineering
locale: en
canonical: true
status: stable
owner: Plugin maintainers
reviewed: 2026-08-07
revision: 2026-08-07
source_of_truth: plugin-ulanzi/VERIFY.md
validators: [pnpm test]
---
# Verifying the AgentDeck Ulanzi plugin (no hardware / no Ulanzi Studio needed)

The official SDK ships a browser **UlanziDeckSimulator**. It renders a virtual
D200H, loads our plugin's actions from its manifest, and runs the WebSocket bridge
on `127.0.0.1:39069`. Our Node main service connects to that bridge exactly as it
would to Ulanzi Studio.

Already set up for you:
- SDK cloned to `tools/ulanzi-sdk/` (gitignored), simulator deps installed.
- Our plugin symlinked into `tools/ulanzi-sdk/UlanziDeckSimulator/plugins/`.
- Action icons generated under `…/resources/icons/`.

## Steps

1. **Build the plugin** (emits the main service):
   ```bash
   pnpm --filter @agentdeck/plugin-ulanzi build
   ```

2. **(Recommended) Run a daemon with a live session** so tiles have content —
   in its own terminal:
   ```bash
   agentdeck daemon start --foreground   # or: agentdeck claude
   ```
   Start a Claude/Codex/OpenCode session so it reaches an `awaiting`/`processing`
   state (that's what animates).

3. **Start the simulator** (its own terminal):
   ```bash
   cd tools/ulanzi-sdk/UlanziDeckSimulator && npm start
   ```
   Open <http://127.0.0.1:39069>.

4. **Start our main service** (its own terminal — runs from the workspace so
   `node_modules`/`@agentdeck/shared`/resvg/gifenc resolve):
   ```bash
   pnpm --filter @agentdeck/plugin-ulanzi sim
   ```
   Expect logs: `daemon connected`, `Ulanzi Studio bridge connected`.

5. **In the simulator UI**: find the **AgentDeck** plugin in the action palette,
   drag the single **AgentDeck** action onto several keys — each key reflows by
   agent state (session, option, mode, stop, usage), then watch:
   - tiles render text + creatures (font fix),
   - an `awaiting`/`processing` Session key shows an **animated GIF** — an amber
     border breathing on `awaiting`, a teal dash orbiting the key on `processing`
     (see [Animation](#animation) for what a correct loop looks like),
   - pressing a key dispatches a command — confirm with `agentdeck daemon status`
     (e.g. button press count / focus change) or the daemon log.

## Animation

Ulanzi Studio plays and loops a GIF on the device itself, so unlike the Stream
Deck plugin — which pushes a fresh image every 150ms tick — this plugin pushes
**one GIF per state transition** and then goes quiet. Steady-state animation costs
nothing on the link.

What that buys has to be paid for at encode time, so three properties are worth
checking whenever the tiles or the schedule change:

- **The loop must close.** A GIF spans exactly one `SESSION_SLOT_ANIM_CYCLE`
  (`shared/src/svg-renderers/session-slot-renderer.ts`), sampled at
  `ANIM_FRAMES` even steps. Any other span leaves the orbiting dash mid-travel at
  the wrap, and the tile jumps once per loop. A live ticker cannot have this bug,
  which is why it went unnoticed; `shared/src/__tests__/session-slot-anim.test.ts`
  and `src/__tests__/anim-schedule.test.ts` are the gates.
- **A key press must stay responsive.** Encoding shares the thread that serves
  Studio's socket, so it runs off the render path a frame at a time: a changed key
  ships its static PNG immediately and upgrades to its GIF when ready. If BACK
  feels sluggish, that path regressed.
- **Keys must not move as one block.** Each key starts its loop at a different
  point in the cycle (`phaseOffsetFor`), so a deck of busy sessions reads as
  several independent activities rather than one synchronised light show. Because
  the frames are an even sample of the cycle, this is a rotation of the frames
  already rendered and costs nothing. If every tile pulses in unison, the rotation
  was lost; if no tile animates at all, the rotation and the encoder's staleness
  check have disagreed (see `frameOrderFor`).
- **Payload stays modest.** Frames are written as delta frames (only pixels that
  changed from the previous frame, GIF disposal 1) over one shared palette, at the
  native 144 canvas rather than `ICON_SIZE`. Expect roughly 21–24 KB for a
  `processing` tile and ~47 KB for `awaiting`; a sudden jump back to ~70 KB means
  the delta or palette path broke.

Set `AGENTDECK_ULANZI_ANIM=0` to fall back to static PNG tiles — useful for
isolating whether a device-side rendering problem involves animation at all.

## Notes
- The main service auto-discovers the daemon port from `daemon.json` (Node CLI or
  App Store Swift sandbox), so it works against either daemon.
- `AGENTDECK_DEBUG=1` (set by `pnpm sim`) enables verbose logs.
- This whole path is dev tooling; nothing here ships in the App Store app.

---

## Real Ulanzi Studio + hardware (recommended over the simulator)

The simulator's key grid is generic and doesn't match the real D200H. To test on
the actual device, install into **Ulanzi Studio** — which launches the Node main
service itself from the installed plugin folder, so the plugin must be
**self-contained** (bundled + shipped `node_modules` with the resvg native + ws).

1. **Install Ulanzi Studio for Mac** from <https://www.ulanzi.com/pages/downloads>
   (Apple silicon build), launch it once, plug in the D200H.

2. **Build + install the self-contained package** (one command):
   ```bash
   pnpm --filter @agentdeck/plugin-ulanzi package:install
   ```
   This bundles the main service, ships `@resvg/resvg-js` (+ native) and `ws`, and
   copies the `.ulanziPlugin` into
   `~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/`.
   (Omit `:install` to only build under `plugin-ulanzi/dist/`.)

3. **Restart Ulanzi Studio.** The **AgentDeck** plugin appears in the action list
   with its single dynamic **AgentDeck** action.

4. Drag that action onto D200H keys, run a daemon + agent session, and verify on real
   hardware: tile rendering, GIF animation on awaiting/processing, key-press dispatch.

Debug the Studio-launched Node service: launch Studio with
`open "/Applications/Ulanzi Studio.app" --args --nodeRemoteDebug`, then open
`chrome://inspect`.

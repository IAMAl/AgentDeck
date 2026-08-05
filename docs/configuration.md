# Configuration

What you can change, and where the file lives.

## Settings

Settings live in `~/.agentdeck/settings.json` (the App Store macOS app uses its
container path — see CLAUDE.md → User data dir). **The file is optional and
nothing creates it for you**: every loader merges its own built-in defaults, so
a missing file is the normal case and you only write the keys you want to
change. `config/default-settings.json` is a reference copy of those built-in
defaults — it is never copied anywhere, and a test
(`bridge/src/__tests__/default-settings-drift.test.ts`) fails the build if it
stops matching the code or grows a key no loader reads.

| Key | Default | Effect |
|-----|---------|--------|
| `llm.mlx.endpoint` · `llm.mlx.model` | `http://127.0.0.1:8800` · `null` | Local MLX server used by the APME judge and the timeline summarizer. `null` model = take whatever the server advertises. |
| `apme.*` | enabled, on-device judge | Evaluation module — schema and semantics in [APME](apme.md). `apme.judge.backend` defaults to `foundationModels` with `fallbackToMlx`. |
| `wakeWord` | *(unset)* | `true` starts the Porcupine listener with the daemon (same as `--wake-word`). |
| `wakeWordMic` · `wakeWordSensitivity` | *(unset)* · `0.5` | Mic name substring and detection sensitivity. See [Wake word](wake-word.md). |
| `voice.locale` | *(system locale)* | BCP-47 tag (e.g. `"en-US"`) for on-device transcription. See [Voice setup](voice-setup.md). |
| `weather.lat` · `weather.lon` · `weather.place` | *(unset)* | Glance weather. No config → no weather card, never an IP-geolocation guess. |
| `calendar.ics` | *(unset)* | Secret-address ICS URL, or a list of them, for the glance schedule. |
| `peripheralMappings` | `[]` | NFC tag uid → steering action mapping. |
| `idotmatrixNamePrefixes` | *(built-in list)* | Widens BLE discovery for iDotMatrix-family displays. |

Keys not in this table are not read. `bridgePort`, `autoRestart`,
`stuckTimeoutMs`, `reconnectIntervalMs`, `voiceLanguage`, `voiceAutoSend`,
`whisperModel` and `apme.autoTune` all appeared in older copies of this page
and of `config/default-settings.json`, but no loader has ever read them from
settings.json — the port comes from the CLI/daemon allocator, the timeouts are
compile-time constants, and `whisperModel` outlived the whisper.cpp path that
was removed in favour of Apple's on-device recognizer.

## Stream Deck Property Inspector

Only the **Launcher encoder (E4)** carries per-instance settings:
`claudeTarget`, `codexTarget`, `openclawTarget` — the working directory each
agent opens in.

The keypad has no per-button configuration. Every key is a `session-slot` whose
content is derived from live session state, and the detail-view quick actions
(GO ON / REVIEW / COMMIT / CLEAR) are defined by the shared layout engine in
`shared/src/d200h-layout.ts`, not by user settings. The earlier configurable
slots 3-6 belonged to the retired mode-dial keypad — see
[Retired and Experimental Surfaces](retired-surfaces.md).

## Prompt templates

`config/prompt-templates.json` holds labelled prompts:

```json
{
  "templates": [
    { "label": "Fix Bug", "prompt": "Please fix the bug described above" },
    { "label": "Test", "prompt": "Write tests for the changes made" }
  ]
}
```

The bridge resolves `send_prompt` commands of the form `__template:<index>`
against this file. **Nothing in the shipped UI emits that command today** — the
encoder that cycled templates was retired with the multi-mode dials, so editing
this file currently has no visible effect. It is documented because the file and
the bridge handler both still exist.

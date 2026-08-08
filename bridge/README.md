# @agentdeck/bridge

The `agentdeck` CLI and daemon for **[AgentDeck](https://github.com/puritysb/AgentDeck)** — a bidirectional local control system that puts AI coding agent sessions (Claude Code, Codex, OpenCode) on physical control surfaces and a terminal dashboard.

Most users should install through the setup wizard instead of this package directly:

```bash
npx @agentdeck/setup
```

Direct install:

```bash
npm install -g @agentdeck/bridge
```

## Usage

```bash
agentdeck claude          # run Claude Code inside an AgentDeck session bridge
agentdeck codex           # same for Codex
agentdeck opencode        # same for OpenCode
agentdeck monitor         # terminal dashboard
agentdeck daemon start    # start the daemon hub (port 9120)
agentdeck devices         # list connected display devices
agentdeck qr              # pairing QR for the iOS/Android companion apps
agentdeck --help          # full command reference
```

The daemon is the hub every dashboard client talks to; session bridges wrap your agent CLI in a PTY, report state via lifecycle hooks, and let paired devices steer the session (answer prompts, approve tools, switch modes).

Full CLI reference: https://github.com/puritysb/AgentDeck/blob/master/docs/cli.md

## Platform notes

- **Node.js 22+** on macOS, Windows 11, or Linux. Native modules install from prebuilt binaries; a compiler is only needed when a prebuild is missing.
- **The published package is identical on every platform** — it carries no machine-built binaries. On macOS 26+, the voice/judge helper (`agentdeck-fm-helper`, Apple Foundation Models + on-device speech) compiles itself on first use into `~/.agentdeck/fm-helper/`; this requires Xcode Command Line Tools (`xcode-select --install`). Without them, voice features report exactly what is missing and everything else keeps working.
- Windows specifics (ConPTY, Scheduled Task autostart): https://github.com/puritysb/AgentDeck/blob/master/docs/windows.md
- Linux specifics (systemd user unit, no Stream Deck app): https://github.com/puritysb/AgentDeck/blob/master/docs/linux.md

## Links

- Project website: https://puritysb.github.io/AgentDeck/
- Repository & docs: https://github.com/puritysb/AgentDeck
- Issues: https://github.com/puritysb/AgentDeck/issues

## License

MIT

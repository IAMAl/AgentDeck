#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Colors ──────────────────────────────────────────────────────────

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const NC = '\x1b[0m';

function info(msg: string) { console.log(`${BLUE}[INFO]${NC} ${msg}`); }
function ok(msg: string) { console.log(`${GREEN}[OK]${NC} ${msg}`); }
function warn(msg: string) { console.log(`${YELLOW}[WARN]${NC} ${msg}`); }
function fail(msg: string) { console.log(`${RED}[FAIL]${NC} ${msg}`); }

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

function which(cmd: string): string | null {
  try {
    // `where` on Windows can print multiple lines (one per match); take the first.
    const probe = IS_WIN ? `where ${cmd}` : `which ${cmd}`;
    const out = execSync(probe, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

// ─── 1. Banner ───────────────────────────────────────────────────────

function banner() {
  console.log('');
  console.log('=========================================');
  console.log('  AgentDeck Setup');
  console.log('=========================================');
  console.log('');
}

// ─── 2. Prerequisites ────────────────────────────────────────────────

function checkPrerequisites(): boolean {
  let pass = true;

  // Node.js >= 22
  const major = parseInt(process.version.replace('v', '').split('.')[0], 10);
  if (major >= 22) {
    ok(`Node.js ${process.version}`);
  } else {
    fail(`Node.js ${process.version} — version 22+ required (Node 20 EOL April 2026)`);
    pass = false;
  }

  // Build tooling — NOT a hard requirement. installBridge tries node-pty's
  // prebuilt binary first and only falls back to a source build, which is the
  // sole thing that needs a compiler. Demanding CLT up front made every user
  // install Xcode tooling for a fallback most of them never hit.
  // Windows always uses the prebuilt binary.
  if (IS_LINUX) {
    // On Linux the source-build fallback needs a C/C++ toolchain + make;
    // python3 is required by node-gyp and by the hook shell.
    const hasCompiler = which('cc') || which('gcc');
    if (hasCompiler && which('make') && which('python3')) {
      ok('Build toolchain (cc/make/python3) installed');
    } else {
      warn('Build toolchain missing — only needed if the prebuilt node-pty binary does not work.');
      console.log(`     Debian/Ubuntu: ${YELLOW}sudo apt install build-essential python3${NC}`);
      console.log(`     Fedora:        ${YELLOW}sudo dnf install gcc-c++ make python3${NC}`);
      console.log(`     Arch:          ${YELLOW}sudo pacman -S base-devel python${NC}`);
    }
  } else if (!IS_WIN) {
    if (which('xcode-select') && checkXcodeCliTools()) {
      ok('Xcode Command Line Tools installed');
    } else {
      warn('Xcode Command Line Tools not installed — only needed if the prebuilt node-pty binary does not work.');
      console.log(`     If the install below fails, run: ${YELLOW}xcode-select --install${NC} and re-run this command.`);
    }
  }

  const hasClaude = Boolean(which('claude'));
  const hasCodex = Boolean(which('codex'));

  // Agent CLIs are optional, like the Stream Deck app below: the daemon and
  // device surfaces install and run without one, and sessions appear as soon
  // as an agent shows up later. Hard-failing here blocked `npx @agentdeck/setup`
  // on machines that only had the Claude/ChatGPT desktop apps (Ulanzi review,
  // 2026-08).
  if (hasClaude) {
    ok('Claude Code CLI found');
  } else {
    warn('Claude Code CLI not found — Claude sessions will be unavailable');
    console.log('     Install with: npm install -g @anthropic-ai/claude-code');
  }

  if (hasCodex) {
    ok('Codex CLI found');
  } else {
    warn('Codex CLI not found — Codex sessions will be unavailable');
  }

  if (!hasClaude && !hasCodex) {
    warn('No coding-agent CLI found — setup continues; sessions appear once an agent is installed.');
    console.log('     Claude Code: npm install -g @anthropic-ai/claude-code   Codex: npm install -g @openai/codex');
  }

  // Stream Deck app — paths differ per OS. The Elgato desktop app is macOS/
  // Windows only, so skip the check on Linux (the bridge + daemon work without
  // it; device control is via the daemon/companion apps).
  if (!IS_LINUX) {
    const streamDeckPaths = IS_WIN
      ? [
          join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Elgato', 'StreamDeck', 'StreamDeck.exe'),
          join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Elgato', 'StreamDeck', 'StreamDeck.exe'),
          join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Elgato', 'StreamDeck', 'StreamDeck.exe'),
        ]
      : ['/Applications/Elgato Stream Deck.app', '/Applications/Stream Deck.app'];
    // Stream Deck is ONE of several surfaces, not a requirement. The daemon runs
    // headless and drives the Ulanzi D200H, the macOS app, the TUI dashboard and
    // ESP32 boards without it. Failing here made `npx @agentdeck/setup` refuse to
    // run for D200H users — who are told to run exactly that by the plugin's own
    // OFFLINE screen (shared/src/d200h-layout.ts).
    if (streamDeckPaths.some((p) => existsSync(p))) {
      ok('Stream Deck app installed');
    } else {
      warn('Stream Deck app not found — Stream Deck keys will be unavailable.');
      console.log('     Other surfaces (Ulanzi D200H, macOS app, `agentdeck dashboard`) work without it.');
      console.log('     Stream Deck app: https://www.elgato.com/downloads');
    }
  }

  if (!pass) {
    console.log('');
    fail('Required dependencies missing. Please install them and re-run.');
  }

  return pass;
}

/// Returns true when `xcode-select -p` reports a valid developer directory.
/// On macOS without CLT installed the command exits non-zero and prints
/// a system dialog prompting the user to install; we treat both as "missing".
function checkXcodeCliTools(): boolean {
  try {
    const path = execSync('xcode-select -p', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // `xcode-select -p` returns the dev dir path even if the user cancelled
    // the install prompt — verify the path actually exists on disk.
    return path.length > 0 && existsSync(path);
  } catch {
    return false;
  }
}

// ─── 3. Stream Deck CLI ──────────────────────────────────────────────

// ─── 4. Install Bridge (agentdeck CLI) ──────────────────────────────

function installBridge() {
  info('Installing AgentDeck bridge (@agentdeck/bridge)...');

  // Prebuilt first. This used to force `npm_config_build_from_source=true` on
  // macOS because of a node-pty prebuilt ABI mismatch (#3), which made a
  // working compiler mandatory for every user. Try the prebuilt binary, and
  // only pay the source-build cost — and its Xcode CLT requirement — if the
  // prebuilt one actually fails. Windows has always used the prebuilt binary:
  // a source build there needs Visual Studio Build Tools.
  try {
    execSync('npm install -g @agentdeck/bridge', { stdio: 'inherit' });
  } catch {
    if (IS_WIN) throw new Error('bridge install failed — see the npm output above');

    warn('Prebuilt install failed — retrying with a source build of node-pty.');
    if (IS_LINUX) {
      const hasCompiler = which('cc') || which('gcc');
      if (!(hasCompiler && which('make') && which('python3'))) {
        fail('A source build needs a C/C++ toolchain (cc/make/python3).');
        console.log(`       Debian/Ubuntu: ${YELLOW}sudo apt install build-essential python3${NC}`);
        console.log('       Then re-run `npx @agentdeck/setup`.');
        process.exit(1);
      }
    } else if (!(which('xcode-select') && checkXcodeCliTools())) {
      fail('A source build needs Xcode Command Line Tools.');
      console.log(`       Install with: ${YELLOW}xcode-select --install${NC}`);
      console.log('       Then re-run `npx @agentdeck/setup`.');
      process.exit(1);
    }
    execSync('npm install -g @agentdeck/bridge', {
      stdio: 'inherit',
      env: { ...process.env, npm_config_build_from_source: 'true' },
    });
  }

  if (which('agentdeck')) {
    ok('agentdeck CLI installed');
  } else {
    fail('agentdeck CLI not found after install — check npm global path');
    process.exit(1);
  }
}

// ─── 5. Install Hooks (inlined from @agentdeck/hooks) ────────────────

const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'Notification',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'TaskCompleted',
  'TeammateIdle',
] as const;

/**
 * Kept byte-identical with `@agentdeck/hooks` `buildHookCommand` and the
 * Swift `HookInstaller.buildHookEntry` snippet. Any change here MUST be
 * mirrored in those two places, otherwise users installing via different
 * paths end up with inconsistent daemon discovery. See `hooks/src/install.ts`
 * for the canonical commentary.
 */
function buildHookCommand(eventName: string): string {
  const preamble = [
    `PORT="\${AGENTDECK_PORT:-}"`,
    `case "$PORT" in ''|*[!0-9]*) PORT="" ;; *) [ "$PORT" -ge 1 ] 2>/dev/null && [ "$PORT" -le 65535 ] 2>/dev/null || PORT="" ;; esac`,
    `if [ -z "$PORT" ]; then`,
    `  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do`,
    `    [ -f "$F" ] || continue`,
    `    P=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));p=d.get('httpPort') or d.get('port');print(p if type(p) is int and 1 <= p <= 65535 else '')" "$F" 2>/dev/null)`,
    `    [ -n "$P" ] && curl -sf --connect-timeout 0.2 --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }`,
    `  done`,
    `fi`,
    `PORT="\${PORT:-9120}"`,
  ];
  // PreToolUse long-poll (device approval) — see canonical commentary in hooks/src/install.ts.
  if (eventName === 'PreToolUse') {
    return preamble.concat([
      `RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/PreToolUse" -H 'Content-Type: application/json' --max-time 60 -d @- 2>/dev/null)`,
      `printf '%s' "\${RESP:-}"`,
    ]).join('\n');
  }
  // Stop is request-response too (turn-end directive queue) — short --max-time
  // since it runs on every turn end. See hooks/src/install.ts.
  if (eventName === 'Stop') {
    return preamble.concat([
      `RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/Stop" -H 'Content-Type: application/json' --max-time 10 -d @- 2>/dev/null)`,
      `printf '%s' "\${RESP:-}"`,
    ]).join('\n');
  }
  // Fire-and-forget telemetry — bounded timeouts are mandatory so a restarting
  // daemon can't hold the socket past Claude's ~1.5s SessionEnd abort budget.
  // See hooks/src/install.ts.
  return preamble.concat([
    `curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST "http://127.0.0.1:$PORT/hooks/${eventName}" -H 'Content-Type: application/json' -d @- >/dev/null 2>&1 || true`,
  ]).join('\n');
}

/** Windows variant — kept in sync with `@agentdeck/hooks` `buildHookCommandWin`.
 *  Ships as `-EncodedCommand` (base64): Claude Code runs a Windows hook THROUGH
 *  PowerShell, and a `-Command "…$var…"` form let that outer shell expand the
 *  script's own $port/$env:AGENTDECK_PORT before the inner powershell saw them,
 *  breaking every hook at `行:1`. A base64 token has no $ or quote to expand, so
 *  it survives cmd.exe and PowerShell alike. */
function buildHookCommandWin(eventName: string): string {
  const lines = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$ProgressPreference='SilentlyContinue'`,
    `[int]$port=0`,
    `[int]$candidate=0`,
    `if(!([int]::TryParse([string]$env:AGENTDECK_PORT,[ref]$candidate)) -or $candidate -lt 1 -or $candidate -gt 65535){$candidate=0}`,
    `$port=$candidate`,
    `if($port -eq 0){`,
    `  $f=Join-Path $env:USERPROFILE '.agentdeck\\daemon.json'`,
    `  if(Test-Path -LiteralPath $f){`,
    `    try{`,
    `      $d=Get-Content -LiteralPath $f -Raw | ConvertFrom-Json`,
    `      $raw=if($d.httpPort){$d.httpPort}else{$d.port}`,
    `      $candidate=0`,
    `      if([int]::TryParse([string]$raw,[ref]$candidate) -and $candidate -ge 1 -and $candidate -le 65535){`,
    `        try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri ('http://127.0.0.1:'+$candidate+'/health')|Out-Null; $port=$candidate}catch{}`,
    `      }`,
    `    }catch{}`,
    `  }`,
    `}`,
    `if($port -eq 0){$port=9120}`,
    // Read stdin as UTF-8: [Console]::In decodes piped stdin with the console OEM
    // codepage (e.g. CP949), garbling non-ASCII payload text.
    `$body=(New-Object System.IO.StreamReader([Console]::OpenStandardInput(),[System.Text.Encoding]::UTF8)).ReadToEnd()`,
    // Post UTF-8 bytes: a string body is encoded ISO-8859-1 without a charset,
    // replacing non-ASCII characters with '?'.
    `$bytes=[System.Text.Encoding]::UTF8.GetBytes([string]$body)`,
    `$uri='http://127.0.0.1:'+$port+'/hooks/${eventName}'`,
  ];
  // PreToolUse (60s) and Stop (10s) are request-response: echo the RAW body so
  // Claude reads the daemon's decision off stdout. Others: fire-and-forget.
  if (eventName === 'PreToolUse' || eventName === 'Stop') {
    const timeout = eventName === 'PreToolUse' ? 60 : 10;
    lines.push(
      `try{$r=Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec ${timeout} -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $bytes; [Console]::Out.Write([string]$r.Content)}catch{}`,
    );
  } else {
    lines.push(
      `try{Invoke-RestMethod -Method Post -TimeoutSec 2 -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $bytes|Out-Null}catch{}`,
    );
  }
  lines.push(`exit 0`);
  const encoded = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

/** The script a hook runs — the Windows `-EncodedCommand` base64 decoded, else
 *  the command verbatim. Lets ownership detection see the `AGENTDECK_PORT` marker
 *  the base64 would otherwise hide. Mirror of `@agentdeck/hooks` decodeHookCommand. */
function decodeHookCommand(cmd: unknown): string {
  if (typeof cmd !== 'string') return '';
  const m = /-EncodedCommand\s+([A-Za-z0-9+/=]+)\s*$/.exec(cmd);
  if (!m) return cmd;
  try {
    return Buffer.from(m[1], 'base64').toString('utf16le');
  } catch {
    return cmd;
  }
}

function isOurHookCommand(cmd: unknown): boolean {
  const text = decodeHookCommand(cmd);
  return text.includes('AGENTDECK_PORT') || text.includes('localhost:9120');
}

/** A settings hook entry (flat or matcher-group) this installer owns. */
function isOurHookEntry(h: any): boolean {
  return isOurHookCommand(h?.command)
    || (Array.isArray(h?.hooks) && h.hooks.some((hh: any) => isOurHookCommand(hh?.command)));
}

function buildHookEntry(eventName: string) {
  const needsToolMatcher = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(eventName);
  const command = IS_WIN ? buildHookCommandWin(eventName) : buildHookCommand(eventName);
  return {
    matcher: needsToolMatcher ? '*' : '',
    hooks: [
      {
        type: 'command',
        command,
      },
    ],
  };
}

/**
 * Strip AgentDeck hooks out of the unwatched `~/.claude/settings.local.json`
 * left behind by installs that predate the settings.json move. Inlined copy of
 * `@agentdeck/hooks` `sweepLegacyHooks` — this package deliberately has no
 * workspace deps because it bootstraps them.
 */
function sweepLegacyHooks(claudeDir: string) {
  const legacyPath = join(claudeDir, 'settings.local.json');
  if (!existsSync(legacyPath)) return;

  try {
    const raw = readFileSync(legacyPath, 'utf-8');
    if (!raw.includes('AGENTDECK_PORT') && !raw.includes('localhost:9120')) return;

    const settings: any = JSON.parse(raw);
    if (!settings.hooks) return;

    for (const event of HOOK_EVENTS) {
      if (!Array.isArray(settings.hooks[event])) continue;
      settings.hooks[event] = settings.hooks[event].filter((h: any) => !isOurHookEntry(h));
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    writeFileSync(legacyPath, JSON.stringify(settings, null, 2) + '\n');
    ok('Removed stale hooks from ~/.claude/settings.local.json (never read by Claude Code)');
  } catch {
    // Best effort — a malformed legacy file must not block a fresh install
  }
}

function installHooks() {
  if (!which('claude')) {
    warn('Skipping Claude Code hooks because `claude` is not installed');
    return;
  }

  info('Installing Claude Code hooks...');

  const claudeDir = join(homedir(), '.claude');
  // Watched by Claude Code at user scope. `settings.local.json` — the file this
  // installer used to target — is resolved against the git root / cwd, so at
  // user scope it is never read. Mirrors `@agentdeck/hooks` `claudeSettingsPaths`
  // and Swift `HookInstaller.claudeSettingsFilename`.
  const settingsPath = join(claudeDir, 'settings.json');

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  sweepLegacyHooks(claudeDir);

  let settings: any = {};
  if (existsSync(settingsPath)) {
    const content = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(content);
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Remove existing AgentDeck hooks (old flat, matcher, and the superseded
    // Windows -Command form) so a re-run replaces rather than duplicates. Matches
    // through the base64 Windows blob via decodeHookCommand.
    settings.hooks[event] = settings.hooks[event].filter((h: any) => !isOurHookEntry(h));

    settings.hooks[event].push(buildHookEntry(event));
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  ok(`Hooks installed to ${settingsPath}`);
}

// ─── 6. Data directory ───────────────────────────────────────────────

function ensureDataDir() {
  const dir = join(homedir(), '.agentdeck');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    ok('Created ~/.agentdeck/');
  }
}

// ─── 6b. Seed compatibility state ────────────────────────────────────

function seedCompatibility() {
  const compatPath = join(homedir(), '.agentdeck', 'compatibility.json');
  if (existsSync(compatPath)) return;
  try {
    const claudeVer = execSync('claude --version', { encoding: 'utf-8', timeout: 5000 })
      .trim()
      .match(/^([\d.]+)/)?.[1];
    let bridgeVer: string | null = null;
    try {
      const list = JSON.parse(
        execSync('npm list -g @agentdeck/bridge --json 2>/dev/null', { encoding: 'utf-8' }),
      );
      bridgeVer = list?.dependencies?.['@agentdeck/bridge']?.version ?? null;
    } catch { /* not installed globally yet */ }
    if (claudeVer) {
      writeFileSync(
        compatPath,
        JSON.stringify(
          {
            lastClaudeCodeVersion: claudeVer,
            lastAgentDeckVersion: bridgeVer,
            lastCheckTime: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
      );
      ok('Compatibility state initialized');
    }
  } catch { /* non-critical */ }
}

// ─── 7. Optional dependencies ────────────────────────────────────────

function checkOptionalDeps() {
  console.log('');
  console.log('----- Optional Dependencies -----');

  if (IS_WIN || IS_LINUX) {
    // Voice needs Apple's on-device speech recognizer, so it is macOS-only.
    // Say so instead of printing `brew` instructions the user can't use.
    warn('Voice input is macOS-only (Apple on-device speech) — skipped.');
    return;
  }

  // Transcription needs nothing installed: it runs through the bundled Swift
  // helper against Apple's on-device recognizer. Only host-mic capture still
  // wants sox — and device-sourced audio (ESP32 knob) doesn't even need that.
  ok('Voice transcription: Apple on-device speech (nothing to install)');

  if (which('sox') || which('rec')) {
    ok('sox installed (host microphone capture)');
  } else {
    warn('sox not found — host-mic voice capture unavailable');
    console.log('     Install with: brew install sox   (not needed for device-sourced audio)');
  }
}

// ─── 8. Success ──────────────────────────────────────────────────────

function success() {
  console.log('');
  console.log('=========================================');
  console.log('  Setup Complete!');
  console.log('=========================================');
  console.log('');
  console.log('  Next steps:');
  if (IS_LINUX) {
    console.log("  1. Run 'agentdeck claude' or 'agentdeck codex' in terminal to start the bridge");
    console.log("     Codex observation hooks are installed automatically by 'agentdeck codex'");
    console.log("  2. Optional: run 'agentdeck daemon install' to auto-start the daemon on login");
    console.log("     (systemd --user unit; run 'loginctl enable-linger $USER' for headless boot)");
  } else {
    console.log('  1. Restart Stream Deck app');
    console.log('  2. Add AgentDeck actions to your Stream Deck profile');
    console.log("  3. Run 'agentdeck claude' or 'agentdeck codex' in terminal to start the bridge");
    console.log("     Codex observation hooks are installed automatically by 'agentdeck codex'");
    console.log("  4. Optional: run 'agentdeck daemon install' to auto-start the daemon on login");
    console.log("     (macOS LaunchAgent / Windows Scheduled Task)");
  }
  console.log('');
  console.log('  Usage:');
  console.log('    agentdeck claude   Start bridge + Claude');
  console.log('    agentdeck codex    Start bridge + Codex');
  console.log('    agentdeck status   Check status');
  console.log('    agentdeck stop     Stop bridge');
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  banner();

  if (!checkPrerequisites()) {
    process.exit(1);
  }

  console.log('');
  installBridge();
  console.log('');
  installHooks();
  ensureDataDir();
  seedCompatibility();
  checkOptionalDeps();
  success();
}

main().catch((err) => {
  fail(`Unexpected error: ${err.message}`);
  process.exit(1);
});

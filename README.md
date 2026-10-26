# probekit

[![npm version](https://img.shields.io/npm/v/probekit.svg)](https://www.npmjs.com/package/probekit)
[![CI](https://github.com/lrzdeveloper/probekit/actions/workflows/ci.yml/badge.svg)](https://github.com/lrzdeveloper/probekit/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/probekit.svg)](https://nodejs.org)

A one-command installer for a complete **app security / reverse-engineering
stack**, driven by an agent (Claude Code or Pi).

It wires up two things:

1. The **`probekit` skill** — a fixed triage flow that decides *how* to
   audit any artifact (macOS/iOS app, Android APK, Electron app, Windows binary,
   firmware, or a GitHub repo), runs provenance/signature checks, scans for
   indicators without getting fooled by scary-but-benign strings, confirms leads
   in decompiled code, optionally captures live network traffic, and produces an
   evidence-backed verdict.
2. The **REA MCP server** (`rea-agents`) — the engine layer that wraps **Ghidra**
   (native decompilation), **JADX** (Android), and **apktool**, registered in
   your agent's config with the right memory/timeout settings.

The skill is the *method*; REA is the *muscle*. This installer connects them and
tells you which engines you still need.

> This installs an orchestration layer **on top of REA** — it does not replace or
> redistribute REA. The REA MCP is fetched from npm (`rea-agents`) on demand.

## Requirements

- **Node 20+** to run probekit itself (the installer is a plain Node script).
- **Node `^22.23.4 || ^24.22.1 || >=26.12.1` to actually drive REA** — the pinned
  `rea-agents@6.8.0` requires it (Node spawns the REA MCP); Node 23 and 25 are not
  supported. This is deliberately *not* in probekit's `engines` (so installing it
  prints no scary `EBADENGINE` warning); instead `probekit doctor` checks your
  Node and tells you plainly if it's too old for REA.
- **JDK 17+** (Ghidra and JADX are Java)
- **Ghidra 12.1.x** — REA pins the 12.1 series; 12.2+ is rejected
- **apktool**, **mitmproxy** (for Android decoding and live network capture)
- macOS or Linux. Engine auto-install assumes Homebrew; otherwise install by hand.

## Usage

```bash
npx probekit                # guided interactive setup (recommended)
npx probekit install        # non-interactive install with discovered defaults
npx probekit doctor         # see what's present / missing
npx probekit setup-engines  # install engines (brew + guided Ghidra)
npx probekit uninstall      # remove MCP entries + Pi skill link
```

### Guided setup

Running `npx probekit` with no command starts a short wizard: it shows the
engine check, asks which agents to wire (Claude Code and/or Pi — only the ones
it detects), lets you confirm the Ghidra heap size, offers to install any
missing engines, then prints exactly what it will change and asks before
writing. Every config file is backed up first. When stdin isn't a terminal
(piped, CI), it falls back to a non-interactive `install` with discovered
defaults.

Or clone and run locally:

```bash
git clone <this repo> && cd probekit
node bin/cli.mjs            # guided setup
```

After installing, **restart Claude Code / Pi** (or reconnect the REA MCP) so the
new server registration is picked up.

### Staying up to date

`npx probekit` always resolves the latest published version, so re-running it
picks up new releases automatically. probekit also does a quiet, once-a-day
check against the npm registry and prints a one-line notice when a newer version
exists (skipped in CI, when output isn't a terminal, or with
`PROBEKIT_NO_UPDATE_CHECK=1`). The REA engine itself is intentionally pinned
(`rea-agents@6.8.0`) so a background REA release can't silently demand a
different Ghidra or Node — bumping it is a deliberate, released change to
probekit.

## What `install` changes

- Copies the skill to `~/.claude/skills/probekit/`, and symlinks it into
  `~/.pi/agent/skills/` if Pi is present.
- Registers an `rea` MCP server in `~/.claude.json` and `~/.pi/agent/mcp.json`,
  with engine paths **discovered on your machine** (not hardcoded):
  - `JAVA_HOME` via `/usr/libexec/java_home` or `brew --prefix openjdk`
  - `GHIDRA_INSTALL_DIR` from the newest `ghidra_12.1.*_PUBLIC` under `~/.rea-tools/`
  - `REA_JADX_MCP_JAR` from `~/.rea-tools/jadx-headless-mcp-*-all.jar`
  - `REA_APKTOOL_COMMAND` from `apktool` on `PATH`
  - `GHIDRA_MAXMEM` sized to ~half your RAM (capped at 16G), and a 30-min startup
    timeout for large binaries
- Backs up every config file it touches (`*.bak.<timestamp>`) before writing.

It never installs or upgrades unrelated software, and never executes an analysis
target.

## The audit flow (what the skill makes the agent do)

```
0. Safety of the analyst  — never execute the target; isolate it; never paste one-liners
1. Identify & route        — what it really is (bytes, not extension) → pick the route
2. Provenance & signature  — who signed it, is it valid, does the identity match?
3. Inventory               — executables, libraries, permissions, helpers, scripts
4. Indicator scan          — hosts, persistence, credential access, exec — leads, not verdicts
5. Static analysis (REA)   — confirm each lead in decompiled code (Ghidra/JADX)
6. Network capture         — mitmproxy, when static analysis can't resolve where data goes
7. Report                  — verdict; every claim marked observed / inferred / unknown
```

## Safety

This is a defensive tool for auditing software you are authorized to analyze.
The skill is built around **not executing** the target and **not** defeating an
app's own protections (e.g. certificate pinning is reported as a *positive*
finding, not bypassed). Captures and any installed CA contain real secrets — the
skill reminds the agent to redact tokens and clean up afterward.

## Development & publishing

```bash
npm test            # node's built-in runner (test/smoke.test.mjs)
node --check bin/cli.mjs
```

CI (`.github/workflows/ci.yml`) runs the tests on Node 20/22/24 for every push
and PR. Releases are published automatically: creating a GitHub Release triggers
`.github/workflows/publish.yml`, which runs `npm publish --provenance --access
public` so the package ships with a signed [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
statement linking it to this repo and commit. It needs one repository secret,
`NPM_TOKEN` (an npm automation token).

To publish manually instead:

```bash
npm publish --access public      # add --provenance only from CI with OIDC
```

## License

MIT


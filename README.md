# probekit

[![npm version](https://img.shields.io/npm/v/@lrzdeveloper/probekit.svg)](https://www.npmjs.com/package/@lrzdeveloper/probekit)
[![CI](https://github.com/lrzdeveloper/probekit/actions/workflows/ci.yml/badge.svg)](https://github.com/lrzdeveloper/probekit/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@lrzdeveloper/probekit.svg)](https://nodejs.org)

A one-command installer for a complete **app security / reverse-engineering
stack**, driven by whichever AI agents you have (Claude Code, Pi, Cursor,
Windsurf, Claude Desktop) — detected automatically, chosen by you.

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

## Quick start

```bash
# from npm (scoped package; the installed command is just `probekit`):
npx @lrzdeveloper/probekit

# or straight from this repo, no npm release needed:
npx github:lrzdeveloper/probekit
```

A short wizard scans your machine, lets you pick which agents to wire (detected
ones default to yes — just press Enter), and applies everything after a
confirmation. Then **restart/reconnect your agent** so probekit shows up.

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
npx @lrzdeveloper/probekit            # guided interactive setup (recommended)

# install globally once, then the command is simply `probekit`:
npm i -g @lrzdeveloper/probekit
probekit                # guided interactive setup
probekit install        # non-interactive install for detected agents
probekit doctor         # see what's present / missing
probekit setup-engines  # install engines (brew + guided Ghidra)
probekit uninstall      # remove REA MCP + skill from all agents
```

### Guided setup

Running `probekit` (or `npx @lrzdeveloper/probekit`) with no command starts a short wizard (clack-style:
clears between steps, keeps a running summary, animates the apply). It scans
your engines and agents, asks **which agents** to wire — detected ones default
to yes, so you can just press Enter — lets you confirm the Ghidra heap size, and
offers to install any missing engines. If your Node is too old for REA **and**
it's Homebrew-managed, it also offers (default no) to run `brew upgrade node`
for you; otherwise it just tells you the version to install. It then prints
exactly what it will change and asks before writing. Every config file is backed
up first. When stdin isn't a terminal (piped, CI), it falls back to a
non-interactive `install` for the detected agents.

Or clone and run locally:

```bash
git clone <this repo> && cd probekit
node bin/cli.mjs            # guided setup
```

After installing, **restart Claude Code / Pi** (or reconnect the REA MCP) so the
new server registration is picked up.

### Staying up to date

`npx @lrzdeveloper/probekit` always resolves the latest published version, so
re-running it picks up new releases automatically. For a global install, probekit
does a quiet, once-a-day check against the npm registry and, when a newer version
exists, **offers to update right there** (`Update now?` → runs
`npm i -g @lrzdeveloper/probekit@latest` for you — no separate step). The check is
skipped in CI, when output isn't a terminal, or with `PROBEKIT_NO_UPDATE_CHECK=1`.

The REA engine itself is intentionally pinned (`rea-agents@6.8.0`) so a
background REA release can't silently demand a different Ghidra or Node —
bumping it is a deliberate, released change to probekit.

## Supported agents

probekit wires into whichever of these it finds on your machine; the guided
setup defaults to the detected ones and lets you add or drop any:

| Agent | REA MCP | probekit skill | Config file |
|---|---|---|---|
| Claude Code | ✓ | ✓ | `~/.claude.json` |
| Pi agent | ✓ | ✓ | `~/.pi/agent/mcp.json` |
| Cursor | ✓ | — | `~/.cursor/mcp.json` |
| Windsurf | ✓ | — | `~/.codeium/windsurf/mcp_config.json` |
| Claude Desktop | ✓ | — | `claude_desktop_config.json` |

The `SKILL.md` audit flow is understood only by Claude Code and Pi; other agents
get the REA MCP tools alone.

## What `install` changes

For each selected agent:

- Registers an `rea` MCP server in that agent's config, with engine paths
  **discovered on your machine** (not hardcoded):
  - `JAVA_HOME` via `/usr/libexec/java_home` or `brew --prefix openjdk`
  - `GHIDRA_INSTALL_DIR` from the newest `ghidra_12.1.*_PUBLIC` under `~/.rea-tools/`
  - `REA_JADX_MCP_JAR` from `~/.rea-tools/jadx-headless-mcp-*-all.jar`
  - `REA_APKTOOL_COMMAND` from `apktool` on `PATH`
  - `GHIDRA_MAXMEM` sized to ~half your RAM (capped at 16G), and a 30-min startup
    timeout for large binaries
- For skill-aware agents (Claude Code, Pi), copies the skill into that agent's
  skills directory.
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


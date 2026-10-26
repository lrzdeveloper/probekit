# probekit

[![npm version](https://img.shields.io/npm/v/@lrzdeveloper/probekit.svg)](https://www.npmjs.com/package/@lrzdeveloper/probekit)
[![CI](https://github.com/lrzdeveloper/probekit/actions/workflows/ci.yml/badge.svg)](https://github.com/lrzdeveloper/probekit/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@lrzdeveloper/probekit.svg)](https://nodejs.org)

probekit installs an app security and reverse-engineering stack into the AI
agents you already use. It finds them on your machine and lets you choose which
ones to set up from a searchable list. The skill works on 80+ agents through
[skills.sh](https://skills.sh). probekit also configures the REA MCP server
automatically for Claude Code, Pi, Cursor, Windsurf, Gemini CLI, GitHub Copilot,
Antigravity, Codex, Zed, OpenCode and Amp.

It sets up two things:

1. The `probekit` skill. It gives the agent a fixed triage flow for auditing an
   artifact (macOS/iOS app, Android APK, Electron app, Windows binary, firmware,
   or a GitHub repo). The agent checks provenance and signatures, scans for
   indicators without being fooled by strings that look scary but are harmless,
   confirms each lead in decompiled code, can capture live network traffic, and
   ends with a verdict backed by evidence.
2. The REA MCP server (`rea-agents`), which wraps Ghidra (native decompilation),
   JADX (Android) and apktool. probekit registers it in each agent's config with
   suitable memory and timeout settings.

The skill describes how to run the audit, and REA does the heavy analysis.
probekit connects the two and tells you which engines are still missing.

> probekit sits on top of REA. It doesn't replace or redistribute it: the REA MCP
> is downloaded from npm (`rea-agents`) when the agent starts it.

## Quick start

```bash
# from npm (scoped package; the installed command is just `probekit`):
npx @lrzdeveloper/probekit

# or straight from this repo, no npm release needed:
npx github:lrzdeveloper/probekit
```

A short wizard checks your machine and asks which agents to set up. The agents it
detected are preselected, so you can just press Enter. Nothing is written until
you confirm. Afterwards, restart or reconnect your agent so probekit shows up.

## Requirements

- Node 20.12+ to run probekit itself (the installer is a plain Node script).
- Node `^22.23.4 || ^24.22.1 || >=26.12.1` to run REA. The pinned
  `rea-agents@6.8.0` requires it, since Node is what starts the REA MCP. Node 23
  and 25 are not supported. This range is left out of probekit's `engines` on
  purpose, so installing probekit doesn't print an `EBADENGINE` warning. Instead,
  `probekit doctor` checks your Node and tells you if it's too old for REA.
- JDK 17+ (Ghidra and JADX run on Java).
- Ghidra 12.1.x. REA pins the 12.1 series and rejects 12.2 and later.
- apktool and mitmproxy, for Android decoding and live network capture.
- macOS or Linux. Automatic engine installs use Homebrew; without it, install
  the engines by hand.

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

Running `probekit` (or `npx @lrzdeveloper/probekit`) with no command starts a
short wizard built with clack. It shows which engines are installed and asks
which agents to set up, with the detected ones preselected. You can then change
the Ghidra heap size and let it install any missing engines. If your Node is too
old for REA and was installed with Homebrew, it also offers to run
`brew upgrade node` (the default answer is no). Otherwise it tells you which
version to install.

Before writing anything it shows exactly what it will change and asks for
confirmation. Every config file is backed up first. When stdin isn't a terminal
(piped input, CI), it runs a non-interactive `install` for the detected agents
instead.

You can also clone the repo and run it locally:

```bash
git clone <this repo> && cd probekit
node bin/cli.mjs            # guided setup
```

After installing, restart Claude Code or Pi (or reconnect the REA MCP) so the
agent loads the new server.

### Staying up to date

`npx @lrzdeveloper/probekit` always runs the latest published version, so
running it again is enough to update. With a global install, probekit checks the
npm registry once a day. When a newer version exists it asks `Update now?` and,
if you say yes, runs `npm i -g @lrzdeveloper/probekit@latest` for you. The check
is skipped in CI, when the output isn't a terminal, or when
`PROBEKIT_NO_UPDATE_CHECK=1` is set.

The REA version is pinned (`rea-agents@6.8.0`) so a new REA release can't
silently require a different Ghidra or Node. Moving to a newer REA means
releasing a new version of probekit.

## Supported agents

Every agent you select gets both the REA MCP and the skill, because the skill
can't do anything without REA. The guided setup preselects the agents it finds.

| Agent | REA MCP | Skill delivered via | MCP config (key / format) |
|---|---|---|---|
| Claude Code | ✓ | native (`SKILL.md`) | `~/.claude.json` · `mcpServers` |
| Pi agent | ✓ | native (`SKILL.md`) | `~/.pi/agent/mcp.json` · `mcpServers` |
| Cursor | ✓ | `skills` CLI | `~/.cursor/mcp.json` · `mcpServers` |
| Windsurf | ✓ | `skills` CLI | `~/.codeium/windsurf/mcp_config.json` · `mcpServers` |
| Gemini CLI | ✓ | `skills` CLI | `~/.gemini/settings.json` · `mcpServers` |
| GitHub Copilot CLI | ✓ | `skills` CLI | `~/.copilot/mcp-config.json` · `mcpServers` |
| Antigravity | ✓ | `skills` CLI | `~/.gemini/antigravity/mcp_config.json` · `mcpServers` |
| Codex | ✓ | `skills` CLI | `~/.codex/config.toml` · `[mcp_servers.rea]` |
| Zed | ✓ | `skills` CLI | `~/.config/zed/settings.json` · `context_servers` |
| OpenCode | ✓ | `skills` CLI | `~/.config/opencode/opencode.json` · `mcp` |
| Amp | ✓ | `skills` CLI | `~/.config/amp/settings.json` · `amp.mcpServers` |

Each agent expects its MCP config in a different shape, and probekit writes the
one that agent understands (checked against each vendor's docs). JSON and JSONC
files are edited in place with
[`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser), so comments
(which Zed, Amp and VS Code allow) and formatting stay as they are and only the
`rea` key changes. Codex uses TOML. There, probekit replaces or removes only the
`[mcp_servers.rea]` tables and leaves the rest of the file and its comments
alone; the result is checked with
[`smol-toml`](https://github.com/squirrelchat/smol-toml) before it's written.
probekit edits the file itself because the `codex` CLI is often a shim that does
nothing outside its own terminal. Every file is backed up first and replaced
atomically.

Claude Code and Pi get a direct copy of the skill. The other agents get it
through the [`skills` CLI](https://skills.sh) (`npx skills add
lrzdeveloper/probekit`), which supports 80+ agents. So the skill reaches many
more tools than the eleven in the table; those eleven are the ones where probekit
also configures the REA MCP for you.

## The skill on 80+ agents (skills.sh)

The probekit skill is listed on [skills.sh](https://skills.sh/lrzdeveloper/probekit),
so any agent supported by the open [`skills`](https://github.com/vercel-labs/skills)
ecosystem can install it:

```bash
npx skills add lrzdeveloper/probekit            # pick agents interactively
npx skills add lrzdeveloper/probekit -a cursor  # or target one
```

> The skill needs the REA MCP to work. If you install only the skill through
> `skills`, also run `npx @lrzdeveloper/probekit` to set up the REA MCP for that
> agent (the skill reminds you of this too). The `probekit` installer always sets
> up both, so it's the simplest way to get everything.

## What `install` changes

For each selected agent, probekit:

- Registers an `rea` MCP server in that agent's config, with engine paths it
  finds on your machine rather than hardcoded ones:
  - `JAVA_HOME` via `/usr/libexec/java_home` or `brew --prefix openjdk`
  - `GHIDRA_INSTALL_DIR` from the newest `ghidra_12.1.*_PUBLIC` under `~/.rea-tools/`
  - `REA_JADX_MCP_JAR` from `~/.rea-tools/jadx-headless-mcp-*-all.jar`
  - `REA_APKTOOL_COMMAND` from `apktool` on `PATH`
  - `GHIDRA_MAXMEM` set to about half your RAM (at most 16G), plus a 30-minute
    startup timeout for large binaries
- Installs the skill, either as a direct copy (Claude Code and Pi) or through the
  `skills` CLI (everything else). The skill is only installed once the REA MCP
  for that agent is in place.
- Backs up every config file it touches (`*.bak.<timestamp>`) before writing.

It never upgrades Node or anything else without asking, and it never runs an
analysis target.

## The audit flow (what the skill makes the agent do)

```
0. Safety of the analyst:  never execute the target; isolate it; never paste one-liners
1. Identify & route:       what it really is (bytes, not extension), then pick the route
2. Provenance & signature: who signed it, is it valid, does the identity match?
3. Inventory:              executables, libraries, permissions, helpers, scripts
4. Indicator scan:         hosts, persistence, credential access, exec (leads, not verdicts)
5. Static analysis (REA):  confirm each lead in decompiled code (Ghidra/JADX)
6. Network capture:        mitmproxy, when static analysis can't show where data goes
7. Report:                 verdict; every claim marked observed / inferred / unknown
```

## Safety

probekit is a defensive tool for auditing software you are allowed to analyze.
The skill never runs the target and never defeats an app's own protections. For
example, certificate pinning is reported as a good sign rather than bypassed.
Captures and any CA certificate you install contain real secrets, so the skill
tells the agent to redact tokens and clean up afterwards.

## Development and publishing

```bash
npm test            # node's built-in runner (test/smoke.test.mjs)
node --check bin/cli.mjs
```

CI (`.github/workflows/ci.yml`) runs the tests on Node 22 and 24 for every push
and pull request. Publishing a GitHub Release triggers
`.github/workflows/publish.yml`, which runs `npm publish --provenance --access
public`. The release tag (for example `v0.1.3`) has to match the version in
`package.json`, and prereleases are published under the `next` dist-tag. The
package ships with a signed [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
statement that links it to this repo and commit. The workflow needs one
repository secret, `NPM_TOKEN` (an npm automation token).

To publish by hand instead:

```bash
npm publish --access public      # add --provenance only from CI with OIDC
```

## License

MIT

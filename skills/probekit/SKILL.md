---
name: probekit
description: >-
  Audit whether an app or artifact is safe to run: does it contain malware,
  spyware, data exfiltration, persistence, or other dangerous behavior. Drives a
  full reverse-engineering stack (REA with Ghidra/JADX/apktool for static
  decompilation, mitmproxy for live network capture) through a fixed triage flow
  and produces a safety verdict backed by evidence. Use whenever the user wants to
  know if something is "safe to use", "legit", "a virus", "malware", "sketchy",
  or "phoning home", for a macOS/iOS app, an Android APK, an Electron app, a
  downloaded binary or installer, a firmware image, or a GitHub repo/release they
  did not write. Also use for "reverse engineer this app", "what does this app
  send", "check this before I install it", "analyze this .app/.apk/.ipa/.dmg/.exe".
  This is the orchestration layer: it decides the route, runs provenance and
  signature checks, scans for indicators, calls REA for decompilation, and runs
  the network capture. It does not replace REA; it directs it. Requires the
  REA MCP server, which you install with `npx @lrzdeveloper/probekit`.
---

# App security audit

> **Requires the REA MCP server.** This skill is the method, and the REA MCP
> tools (`mcp__rea__*`, which wrap Ghidra/JADX/apktool) do the heavy work. The
> skill cannot do its job without them.
>
> Check this before anything else: if no `mcp__rea__*` tools are available in
> this agent, stop and tell the user to run `npx @lrzdeveloper/probekit` (it
> wires the REA MCP into their agents), then restart the agent. Do not start a
> half audit without REA. Only if the user explicitly asks to go ahead anyway,
> do the checks that need no REA (provenance, signatures, strings, network
> capture), label the result as partial, and never give a full verdict.

You are answering one question: **is this artifact safe to run, or does it do
something the user would not want?** Everything else serves that question.

This skill drives a stack you probably already have: REA (the
`reverse-engineer-anything` skill and its MCP tools, which wrap Ghidra, JADX,
and apktool), mitmproxy for network capture, and ordinary shell tools. It does
not re-teach REA. When you need to decompile, read REA's own guidance and call
its tools. This skill covers the *audit*: the order to work in, what to look
for, how to avoid being fooled, and how to report honestly.

## First: safety of the analyst

The target is untrusted until proven otherwise. Treat it as evidence, not as
software.

- **Never execute the target or anything inside it** to "see what it does"
  unless the user explicitly asks for a live run AND you have isolation. Static
  analysis and passive network capture answer most questions without execution.
- Put the target in its own fresh directory. Downloaded files and extracted
  archives are untrusted data: a planted `json.py` or `build.gradle` can run code
  the moment you `import json` or invoke a build tool from inside that directory.
  Keep your own scripts elsewhere and pass target paths as arguments. Run any
  helper interpreter with isolation flags (e.g. `python3 -I`).
- Never paste and run install one-liners from the target's README, a web page,
  or a `curl … | bash`. Decode and read them first, then report what they do.
- If a step needs the user's password (trusting a CA, loading a system
  extension), give the exact command to the user. Do not try to `sudo` yourself.

## The triage flow

Work in this order. Each stage narrows the question for the next, and skipping
ahead wastes effort and leads to shallow verdicts. Stop early only if a stage
finds something that settles the question (e.g. a revoked signature plus an
obvious dropper). In that case, report and advise.

1. **Identify and route.** Work out what the artifact really is from its bytes
   and structure, not just the extension. Pick the route (see "Routing" below)
   and isolate the files.
2. **Provenance and signature.** Who signed it, is the signature valid, was it
   notarized/attested, and does the identity match the claimed author? A valid
   signature does not guarantee safety, but a broken or missing one on something
   that claims to be a real product is a strong early signal. Platform details
   are in the route reference.
3. **Inventory.** List what's inside: executables, linked libraries, declared
   permissions/entitlements, bundled helpers, config, scripts. Note anything
   that can run code or persist.
4. **Indicator scan.** Pull strings and look for the behaviors that matter (hosts
   contacted, persistence, credential/keychain/cookie/wallet access, shelling
   out, self-modification). This step produces leads, not a verdict. See
   "Reading indicators without fooling yourself".
5. **Static analysis with REA.** Confirm every lead that matters in the
   decompiled code. A string proves that text exists; only the code around it
   proves behavior. Ghidra and JADX do most of the work here.
6. **Network capture (when warranted).** Watch what the app actually contacts at
   runtime with mitmproxy. Do this when static analysis can't tell where data
   goes, or to confirm what it found. See `references/network-capture.md`.
7. **Report.** Give the verdict, tie every claim to evidence, and label each one
   honestly as observed, inferred, or unknown. See "Report".

## Routing

Choose the route from what the artifact is. Read the matching reference before
you start that route; each one gives the exact commands and the REA entry point.

| Target | Route reference | REA entry (via its MCP tools) |
|---|---|---|
| macOS `.app`, `.dmg`, Mach-O binary | `references/apple.md` | `open_binary` + Ghidra provider |
| iOS `.ipa` | `references/apple.md` | archive inventory, then Mach-O (note encryption) |
| Android `.apk` / `.aab` | `references/android.md` | `inspect_android_package` (JADX), apktool |
| Electron app (`.asar`, resources) | `references/electron.md` | `analyze_javascript_application` |
| Windows `.exe` / `.dll`, .NET | `references/binaries.md` | `open_binary` / managed inspect |
| Firmware image | `references/binaries.md` | `inspect_firmware_regions` / `extract_firmware` |
| GitHub repo / release | `references/github-repo.md` | normal source review; REA only for shipped binaries |
| Loose binary, unknown | `references/binaries.md` | `open_binary` (auto provider) |

If the user says only "my app" with no name or path, ask which one. Do not guess
from nearby files or old reports.

## Reading indicators without fooling yourself

Most confident-sounding mistakes happen in the indicator scan (stage 4). Watch
for two failure modes:

- **Dictionary noise.** Large binaries (anything that embeds a browser, an ICU
  table, or a word list) contain substrings that look like `http://…`,
  `password`, `token` by pure chance. Filter hard: limit line length, match real
  URL shapes, and treat a hit as a question to check, not a finding.
- **Scary strings in harmless code.** Real, harmless code can contain alarming
  text. One real audit found `do shell script "rm -rf '…'" with administrator
  privileges`, which turned out to be the stock Tauri auto-updater replacing its
  own bundle. A `keychain` symbol may be the OS API a password manager uses
  legitimately. **Never report a string as a finding until you've read the code
  that uses it** (stage 5) and understood what it is for.

What to look for:

- Network: every host/URL/IP the artifact talks to. Separate first-party hosts
  (the author's domains, expected cloud APIs) from everything else. An
  unexpected host is the most valuable lead you can find.
- Persistence: LaunchAgents/LaunchDaemons, login items, `SMAppService`, cron,
  systemd units, registry Run keys, scheduled tasks.
- Credential and data access: Keychain/`SecItem`, browser `Login Data`/`Cookies`,
  SSH keys, `TCC.db`, crypto wallets, Telegram/Signal stores.
- Execution and evasion: `osascript`/AppleScript, `/bin/sh -c`, `NSTask`,
  `posix_spawn`, `curl|bash`, base64-decoded payloads, debugger/VM/sandbox
  detection, code that writes a file in `/tmp` and then runs it.
- Telemetry: Sentry/PostHog/Amplitude/etc. This is not malware, but name it so
  the user knows what leaves the machine.

## Using REA well here

- Open the smallest relevant artifact first (e.g. a 7 MB helper before a 27 MB
  main binary). The first analysis finishes sooner and the techniques are the same.
- Ghidra (headless, via REA) often does not index Rust/Go string literals, so an
  empty `search_strings` does **not** mean the text is absent. Combine REA with
  shell `strings` + `nm -C` (demangled symbols) to find function names, then use
  REA to decompile by address. This combination is what makes the stack work on
  modern binaries that look stripped.
- Big binaries can exceed Ghidra's default memory or time limits. If analysis
  times out, fix the configuration (heap, timeout) instead of giving up.
  `references/rea-stack.md` lists the environment settings and how to raise them.
- Decompiled Rust/Go/C++ is verbose. Focus on the symbol names and the few calls
  that matter (file writes, HTTP sends, `Command`/spawn, digest/verify) instead
  of reading every line.

`references/rea-stack.md` has the tool inventory, how to discover what's
installed, the known-good configuration, and recovery steps when a provider is
missing.

## Network capture essentials

The full playbook is in `references/network-capture.md`. These rules keep the
capture honest and non-invasive:

- Use mitmproxy **local mode scoped to the target's process names** so you
  capture only the app under test, never the user's whole machine. The user can
  keep everything else open.
- Many well-built apps **pin certificates** (they embed their own CA roots and
  ignore the system/user keychain). mitmproxy then fails with `UnknownIssuer` on
  those connections. **That is a positive security finding.** Report it instead
  of trying to defeat it. Add those hosts to a passthrough ignore-list so the app
  works, and still record *which hosts* it contacts (DNS/SNI) even when you can't
  read the bodies.
- Do not patch the binary or inject code to strip pinning unless the user
  explicitly asks and understands that you would then be analyzing a modified
  app. Offer it as an option and explain the cost; never make it the default.
- Capture files and the CA you install contain real secrets and tokens. Redact
  tokens in the analysis, and give the user the cleanup commands (remove the CA,
  delete the capture) at the end.

## Report

Produce a report with this shape. Adapt the headings to the target, but keep the
evidence discipline, because the report is worthless without it.

```
# Security audit: <artifact name and version>

## Verdict
<One clear sentence: safe to use / safe with caveats / unsafe / inconclusive.>

## Identity & signature
<Who signed it, validity, notarization/attestation, author match.>

## What it does on the network
<Hosts contacted and why; first-party vs third-party; pinning; telemetry.>

## Handling of sensitive data
<Credentials/tokens: where stored, permissions, whether OS keystore is used.>

## Code execution & integrity
<Does it run other code, download+execute, verify what it runs (signatures/hashes).>

## Caveats & residual risk
<Real risks that are about *use*, not malware, stated plainly.>

## What was and wasn't checked
<Static only? Was runtime observed? What's still unknown. Analysis limits.>
```

Evidence discipline is non-negotiable, because it is what separates an audit
from a guess:

- **Observed** means you saw it in bytes, decompiled code, or a capture. Cite it
  (REA Evidence IDs, the symbol/address, the captured host).
- **Inferred** means you reasoned from observations. Say so, and say from which ones.
- **Unknown** means not checked or not checkable (e.g. what a remote server does
  with the data it receives). Name it, and never imply that static analysis
  observed execution.
- A valid signature proves authenticity, not safety. Pinning and hash checks
  show that the app protects *its own* integrity; they say nothing about the
  author's intent. Keep these distinctions clear for the user.

When you're done, offer a report file if the user is on a device that can
receive files and one would help. Otherwise the summary in chat is enough.

# Route: GitHub repo / release

Two very different questions hide here. Decide which the user is asking:

1. **"Is this source code safe to build/run?"** → source review + supply-chain.
2. **"Is the binary they ship safe?"** → download the release artifact and route
   it as a binary/app (REA on the shipped artifact, not the source).

Often you want both: read the source for intent, then confirm the published
binary was actually built from it (or at least contains no extra surprises).

## Get it safely

```bash
mkdir -p /tmp/audit-<name> && cd /tmp/audit-<name>
git clone --depth 1 <url> src        # source stays data; don't run its scripts
gh release download -R <owner>/<repo> -p '<asset>' -D ./release   # shipped binary, if auditing that
```

Treat the clone as untrusted data (see SKILL.md "safety of the analyst"): don't
`npm install`, `make`, or run any repo script to "check it".

## Source review — intent & supply chain

- **Install/build hooks that run on fetch**: npm `preinstall`/`postinstall` and
  `scripts`, Python `setup.py`/`pyproject` build backends, `build.rs`, Makefile
  default targets, `.github/workflows` with secrets access. These run code on a
  contributor's machine — a classic supply-chain vector.
- **Dependencies**: lockfile present? Any dep pinned to a git URL, a typo-squat
  name, or an unusual registry? Postinstall scripts in dependencies?
- **Obfuscation / fetch-and-exec**: base64/hex blobs, `eval`/`exec`, code that
  downloads then runs something at build or runtime, minified files in a
  "source" repo.
- **Secrets & exfiltration**: hardcoded tokens, code that reads `~/.ssh`, env
  dumps, telemetry posting to odd hosts.
- **Signals of trust** (context, not proof): stars/age/history, release
  signing/attestation, whether tags are signed, maintainer identity.

## Does the binary match the source?

If a release ships a binary, you usually **cannot** assume it was built from the
visible source. Options, strongest first:
- Reproducible build / published build provenance / SLSA attestation → verify it.
- Otherwise, audit the shipped binary on its own (route it as a binary/app) and
  say plainly that source↔binary correspondence was **not** established — only
  that the binary itself showed (or didn't show) concerning behavior.

## Report framing

Separate "the source, as read, does X" from "the published artifact does Y."
Supply-chain risk (what runs when *you* install/build) is distinct from runtime
risk (what the program does when it runs) — name both for the user.

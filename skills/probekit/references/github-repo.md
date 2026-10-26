# Route: GitHub repo / release

This covers two different questions. Decide which one the user is asking:

1. "Is this source code safe to build/run?" → review the source and the supply chain.
2. "Is the binary they ship safe?" → download the release artifact and route it
   as a binary/app (REA on the shipped artifact, not the source).

Often you want both: read the source to understand intent, then confirm that the
published binary was actually built from it (or at least contains nothing extra).

## Get it safely

```bash
mkdir -p /tmp/audit-<name> && cd /tmp/audit-<name>
git clone --depth 1 <url> src        # source stays data; don't run its scripts
gh release download -R <owner>/<repo> -p '<asset>' -D ./release   # shipped binary, if auditing that
```

Treat the clone as untrusted data (see "safety of the analyst" in SKILL.md).
Don't `npm install`, `make`, or run any repo script to "check it".

## Source review: intent and supply chain

- Install/build hooks that run on fetch: npm `preinstall`/`postinstall` and
  `scripts`, Python `setup.py`/`pyproject` build backends, `build.rs`, Makefile
  default targets, `.github/workflows` with secrets access. These run code on a
  contributor's machine and are a classic supply-chain attack path.
- Dependencies: is there a lockfile? Is any dependency pinned to a git URL, given
  a typo-squatted name, or pulled from an unusual registry? Do dependencies have
  postinstall scripts?
- Obfuscation and fetch-and-exec: base64/hex blobs, `eval`/`exec`, code that
  downloads something and runs it at build time or runtime, minified files in a
  "source" repo.
- Secrets and exfiltration: hardcoded tokens, code that reads `~/.ssh`, env
  dumps, telemetry posting to odd hosts.
- Trust signals (context, not proof): stars, age and history, release
  signing/attestation, whether tags are signed, maintainer identity.

## Does the binary match the source?

If a release ships a binary, you usually **cannot** assume it was built from the
visible source. Options, strongest first:
- Reproducible build / published build provenance / SLSA attestation → verify it.
- Otherwise, audit the shipped binary on its own (route it as a binary/app). Say
  plainly that you did **not** establish that the binary matches the source, only
  whether the binary itself showed concerning behavior.

## Report framing

Keep "the source, as read, does X" apart from "the published artifact does Y."
Supply-chain risk (what runs when *you* install/build) is different from runtime
risk (what the program does when it runs). Name both for the user.

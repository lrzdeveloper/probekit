# Route: Windows PE / .NET, firmware, and loose/unknown binaries

## Identify first

```bash
file <target>
xxd <target> | head          # magic bytes when `file` is unsure
shasum -a 256 <target>       # record identity; useful for VT/known-sample lookups the user may run
```

`MZ`→PE (Windows), `\x7fELF`→ELF (Linux/Android native/firmware payload),
`\xca\xfe\xba\xbe`/`\xcf\xfa\xed\xfe`→Mach-O (use `apple.md`), `PK`→zip-family
(APK/IPA/JAR/MSIX — route by contents).

## Windows PE / .NET

- Native PE/DLL: REA `open_binary` (Ghidra). Check imports for the usual suspects
  (`VirtualAlloc`+`CreateRemoteThread` injection, `WinHttp`/`WinINet` hosts,
  `RegSetValue` Run-key persistence, `CreateService`, crypto APIs), and
  `inspect_pe_resources` for embedded payloads/icons.
- Managed .NET assembly: REA `inspect_managed_artifact` / managed members — IL
  decompiles cleanly to near-source C#. Watch for `Assembly.Load(byte[])`,
  reflection, `Process.Start`, base64 blobs.
- Authenticode: verify the signature and publisher (`signtool verify` on Windows;
  `osslsigncode verify` cross-platform). Absent/invalid on a "real product" is a
  flag.

## Firmware images

- `inspect_firmware_regions` to map it; `extract_firmware` (caller-supplied
  Binwalk/Unblob on Linux) into a **fresh output directory** to carve
  filesystems/bootloaders.
- Then triage the extracted root like a small system: hardcoded credentials,
  `/etc` startup scripts, embedded keys/certs, telnet/backdoor services, and
  native binaries (ELF → `open_binary`).

## Loose / unknown binary

`open_binary` with auto provider. Combine with shell `strings`, `nm -C`, and the
indicator scan from SKILL.md. If it's a script (shell/Python/PowerShell/JS),
**read it, never run it** — deobfuscate base64/hex/`eval` layers by hand and
report what each layer would do.

## A note on `curl … | bash` and install one-liners

If the "app" is really an install command or script, that's the audit target.
Decode every layer, resolve what it downloads and from where, and report the
chain. Do not execute it to find out. A remote script piped straight to a shell
is itself a risk worth stating to the user regardless of what this instance of it
happens to contain.

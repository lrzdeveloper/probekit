# Route: Windows PE / .NET, firmware, and loose/unknown binaries

## Identify first

```bash
file <target>
xxd <target> | head          # magic bytes when `file` is unsure
shasum -a 256 <target>       # record identity; useful for VT/known-sample lookups the user may run
```

`MZ`→PE (Windows), `\x7fELF`→ELF (Linux/Android native/firmware payload),
`\xca\xfe\xba\xbe`/`\xcf\xfa\xed\xfe`→Mach-O (use `apple.md`), `PK`→zip-family
(APK/IPA/JAR/MSIX; route by contents).

## Windows PE / .NET

- Native PE/DLL: REA `open_binary` (Ghidra). Check imports for the usual suspects
  (`VirtualAlloc`+`CreateRemoteThread` injection, `WinHttp`/`WinINet` hosts,
  `RegSetValue` Run-key persistence, `CreateService`, crypto APIs), and
  `inspect_pe_resources` for embedded payloads/icons.
- Managed .NET assembly: REA `inspect_managed_artifact` / managed members. IL
  decompiles cleanly to C# that is close to the source. Watch for
  `Assembly.Load(byte[])`, reflection, `Process.Start`, base64 blobs.
- Authenticode: verify the signature and publisher (`signtool verify` on Windows;
  `osslsigncode verify` on any platform). A missing or invalid signature on a
  "real product" is a red flag.

## Firmware images

- Map it with `inspect_firmware_regions`, then run `extract_firmware`
  (caller-supplied Binwalk/Unblob on Linux) into a **fresh output directory** to
  carve out filesystems/bootloaders.
- Triage the extracted root like a small system: hardcoded credentials, `/etc`
  startup scripts, embedded keys/certs, telnet/backdoor services, and native
  binaries (ELF → `open_binary`).

## Loose or unknown binary

Use `open_binary` with the auto provider, together with shell `strings`,
`nm -C`, and the indicator scan from SKILL.md. If it's a script
(shell/Python/PowerShell/JS), **read it, never run it**. Deobfuscate the
base64/hex/`eval` layers by hand and report what each layer would do.

## A note on `curl … | bash` and install one-liners

If the "app" is really an install command or script, that's the audit target.
Decode every layer, work out what it downloads and from where, and report the
chain. Do not execute it to find out. Piping a remote script straight into a
shell is a risk in itself, and you should tell the user so whatever this
particular script contains.

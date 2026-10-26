# Route: Android `.apk` / `.aab`

An APK is a zip. The behavior lives in DEX bytecode (Java/Kotlin), sometimes in
native `.so` libraries, and the risk posture is set by the manifest.

## Signature & provenance

```bash
apksigner verify --verbose --print-certs app.apk   # scheme v1/v2/v3, signer cert, SHA-256
# or: keytool -printcert -jarfile app.apk
```

Note the signing certificate and its digest. For an app that claims to be from a
known vendor, compare against the vendor's known signing cert if you have it. A
debug cert (`CN=Android Debug`) on something presented as a release build is a
flag.

## Manifest & permissions (the fastest signal)

Via REA (JADX provider) `inspect_android_package`, or:

```bash
apktool d -f -o out_dir app.apk       # decodes manifest + resources
# read out_dir/AndroidManifest.xml
```

Look for:
- **Dangerous/▲ permissions** out of proportion to the app's purpose:
  `SEND_SMS`, `READ_SMS`, `READ_CONTACTS`, `RECORD_AUDIO`, `ACCESS_FINE_LOCATION`,
  `READ_CALL_LOG`, `SYSTEM_ALERT_WINDOW`, `REQUEST_INSTALL_PACKAGES`,
  `BIND_ACCESSIBILITY_SERVICE` (overlay + accessibility abuse is a spyware
  hallmark), `QUERY_ALL_PACKAGES`.
- **Exported components** (`android:exported="true"`) — receivers/services/
  activities reachable by other apps; an attack surface.
- **`BOOT_COMPLETED` receiver** = persistence across reboot.
- Backup/cleartext flags: `usesCleartextTraffic`, `allowBackup`.

## Code (DEX) with REA/JADX

```
mcp__rea__inspect_android_package { ... }   # then search_android_classes / inspect_android_method
```

JADX decompiles DEX to readable Java. Follow the leads: reflection +
`DexClassLoader`/`loadLibrary` (dynamic code loading), `Runtime.exec`, HTTP
clients and the hosts they hit, crypto that looks like obfuscation, access to
`/data/data/<other app>`. Heavy obfuscation (`a.a.a`) isn't proof of malice but
raises the bar and is worth reporting.

## Native libraries

`.so` files under `lib/<abi>/` are ARM/x86 ELF — hand them to REA
`open_binary` (Ghidra) like any native binary. Games, DRM, and anti-cheat
legitimately use them; so does packed malware hiding its real logic.

## Optional dynamic analysis

If the user wants runtime behavior and has a device/emulator, REA's ADB tools
(`list_adb_packages`, `read_adb_logcat`, `capture_adb_screen`) and mitmproxy
(Android trusts user CAs only for apps targeting older API levels, or needs a
system CA / Frida on newer ones) apply. The APK is never launched during static
analysis.

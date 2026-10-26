# Route: Android `.apk` / `.aab`

An APK is a zip. The behavior lives in DEX bytecode (Java/Kotlin), sometimes in
native `.so` libraries, and the manifest decides how much risk the app can carry.

## Signature and provenance

```bash
apksigner verify --verbose --print-certs app.apk   # scheme v1/v2/v3, signer cert, SHA-256
# or: keytool -printcert -jarfile app.apk
```

Note the signing certificate and its digest. For an app that claims to be from a
known vendor, compare it with the vendor's known signing cert if you have it. A
debug cert (`CN=Android Debug`) on something presented as a release build is a
red flag.

## Manifest and permissions (the fastest signal)

Via REA (JADX provider) `inspect_android_package`, or:

```bash
apktool d -f -o out_dir app.apk       # decodes manifest + resources
# read out_dir/AndroidManifest.xml
```

Look for:
- Dangerous permissions out of proportion to the app's purpose:
  `SEND_SMS`, `READ_SMS`, `READ_CONTACTS`, `RECORD_AUDIO`, `ACCESS_FINE_LOCATION`,
  `READ_CALL_LOG`, `SYSTEM_ALERT_WINDOW`, `REQUEST_INSTALL_PACKAGES`,
  `BIND_ACCESSIBILITY_SERVICE` (overlay + accessibility abuse is a spyware
  hallmark), `QUERY_ALL_PACKAGES`.
- Exported components (`android:exported="true"`): receivers/services/
  activities that other apps can reach, which makes them attack surface.
- A `BOOT_COMPLETED` receiver, which means persistence across reboots.
- Backup/cleartext flags: `usesCleartextTraffic`, `allowBackup`.

## Code (DEX) with REA/JADX

```
mcp__rea__inspect_android_package { ... }   # then search_android_classes / inspect_android_method
```

JADX decompiles DEX to readable Java. Follow the leads: reflection with
`DexClassLoader`/`loadLibrary` (dynamic code loading), `Runtime.exec`, HTTP
clients and the hosts they hit, crypto that looks like obfuscation, access to
`/data/data/<other app>`. Heavy obfuscation (`a.a.a`) doesn't prove malice, but
it makes the analysis harder and is worth reporting.

## Native libraries

`.so` files under `lib/<abi>/` are ARM/x86 ELF. Pass them to REA `open_binary`
(Ghidra) like any native binary. Games, DRM, and anti-cheat code use them
legitimately, and so does packed malware that hides its real logic.

## Optional dynamic analysis

If the user wants runtime behavior and has a device or emulator, you can use
REA's ADB tools (`list_adb_packages`, `read_adb_logcat`, `capture_adb_screen`)
and mitmproxy. Android trusts user CAs only for apps that target older API
levels; newer ones need a system CA or Frida. Static analysis never launches
the APK.

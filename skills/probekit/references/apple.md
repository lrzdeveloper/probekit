# Route: macOS `.app` / `.dmg` / Mach-O, and iOS `.ipa`

## Provenance and signature (do this before touching the code)

```bash
APP=/path/to/Target.app
codesign -dvvv "$APP" 2>&1          # authority chain, TeamID, runtime flags, notarization ticket
spctl -a -vvv "$APP" 2>&1           # Gatekeeper acceptance (Notarized Developer ID?)
codesign --verify --deep --strict -v "$APP" 2>&1   # nothing tampered post-signing
codesign -d --entitlements - --xml "$APP/Contents/MacOS/<exe>" 2>/dev/null | plutil -p -
xattr -l "$APP"                     # com.apple.quarantine shows where it came from
```

Read the results honestly:
- A valid Developer ID, notarization, and a stapled ticket mean Apple checked it
  and the author is identifiable. That proves authenticity, not safety.
- A broken or missing signature, or a `--verify` failure, on something that
  claims to be a shipping product is a strong early warning.
- Entitlements tell you what it's *allowed* to do: camera, mic, Apple Events
  (automation of other apps), `com.apple.security.cs.disable-library-validation`
  (loads unsigned code, worth noting), network client/server. Fewer entitlements
  mean less to worry about.

## Inventory

```bash
cat "$APP/Contents/Info.plist"      # or plutil -p; bundle id, version, URL schemes, LSUIElement
find "$APP/Contents" -maxdepth 4    # helpers, XPC services, bundled providers, frameworks
for f in "$APP"/Contents/MacOS/* "$APP"/Contents/Resources/**/<helpers>; do
  file "$f"; otool -L "$f" | tail -n +2;   # linked libraries: system-only is calmer than bundled dylibs
  codesign -dvv "$f" 2>&1 | grep -E 'Authority=Developer|TeamIdentifier'
  shasum -a 256 "$f"
done
```

Linking only system frameworks (`/System/Library/...`, `/usr/lib/...`) is
normal. A bundled network or crypto dylib is worth a look. Helpers signed with a
*different* TeamID than the main app are a red flag.

## Persistence and on-disk footprint

```bash
ls ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons 2>/dev/null | grep -i <name>
ls -la ~/Library/Application\ Support/<bundle-id> ~/Library/Preferences/<bundle-id>* 2>/dev/null
```

For a simple app, the expected case is no LaunchAgent, no login item, and no
`SMAppService` registration.

## Static analysis with REA

```
mcp__rea__open_binary { path: "<...>/Contents/MacOS/<exe>", provider_id: "ghidra" }
```

Then follow the `rea-stack.md` pattern: use `nm -C` to find the functions that
matter (network sends, file writes, `Command`/spawn, Keychain/`SecItem`,
digest/verify) and `procedure_pseudo_code` by address to read them. Open the
smallest helper binary first. For Objective-C, use `get_objc_classes` /
selectors; for Swift, `demangle_swift`.

## iOS `.ipa` notes

An `.ipa` is a zip; inventory its `Payload/<App>.app` the same way. App Store
binaries, however, are **FairPlay-encrypted**: static decompilation of the main
executable returns ciphertext unless it was decrypted on a jailbroken device.
Entitlements, `Info.plist`, the embedded provisioning profile, frameworks, and
the `ATS` / URL-scheme declarations are still readable and often answer the
question. Say clearly when the main binary couldn't be read because of
encryption.

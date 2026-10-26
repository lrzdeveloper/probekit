# Route: Electron apps

Electron apps ship their real logic as JavaScript, usually packed into an
`app.asar` (sometimes `app.asar` + `app.asar.unpacked`, or an unpacked `app/`
tree). The native `Electron` binary is mostly the runtime — don't waste time
decompiling it; go for the JS.

## Locate the code

- macOS: `Target.app/Contents/Resources/app.asar`
- Windows/Linux: `resources/app.asar` next to the executable

Signature check still applies first (use the platform route: `apple.md` for a
`.app`, `binaries.md` for a Windows build).

## Analyze the JavaScript with REA

Point REA at the asar or the extracted tree:

```
mcp__rea__analyze_javascript_application { path: "<...>/app.asar", detail: "summary" }
```

Use `detail: "summary"` first on anything of unknown size, then drill into
modules with `inspect_analysis_view` on the returned evidence id. REA's
JavaScript recipes cover feature tracing and module views — read them rather than
dumping the whole bundle into context.

## What to look for

- **`main` process capabilities**: `child_process` (`exec`/`spawn`), `fs` writes
  outside app dirs, `net`/`https` to non-first-party hosts, `nativeImage`/
  clipboard, `autoUpdater` feed URLs.
- **Preload scripts & `contextBridge`**: what's exposed to the renderer. A broad
  `nodeIntegration: true` with remote content loaded is dangerous by design.
- **`BrowserWindow` loading remote URLs** vs local files — remote content with
  Node access is the classic Electron RCE shape.
- **Obfuscated/minified payloads, base64 blobs, `eval`, `Function(...)`,
  dynamically fetched-then-executed code.**
- **Telemetry SDKs** and the endpoints they post to.

## Runtime (optional)

For live behavior, REA can observe an already-open Electron target
(`list_electron_targets`, `observe_javascript_runtime`), and the mitmproxy
network capture (`network-capture.md`) works the same as for any app — scope to
the Electron process name(s).

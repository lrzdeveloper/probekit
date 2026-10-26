# Route: Electron apps

Electron apps ship their real logic as JavaScript, usually packed into an
`app.asar` (sometimes `app.asar` + `app.asar.unpacked`, or an unpacked `app/`
tree). The native `Electron` binary is mostly the runtime, so don't spend time
decompiling it. Go straight to the JS.

## Locate the code

- macOS: `Target.app/Contents/Resources/app.asar`
- Windows/Linux: `resources/app.asar` next to the executable

Check the signature first, using the platform route (`apple.md` for a `.app`,
`binaries.md` for a Windows build).

## Analyze the JavaScript with REA

Point REA at the asar or the extracted tree:

```
mcp__rea__analyze_javascript_application { path: "<...>/app.asar", detail: "summary" }
```

Use `detail: "summary"` first on anything of unknown size, then drill into
modules with `inspect_analysis_view` on the returned evidence id. REA's
JavaScript recipes cover feature tracing and module views. Read them instead of
dumping the whole bundle into context.

## What to look for

- What the `main` process can do: `child_process` (`exec`/`spawn`), `fs` writes
  outside app dirs, `net`/`https` to non-first-party hosts, `nativeImage`/
  clipboard, `autoUpdater` feed URLs.
- Preload scripts and `contextBridge`: what the renderer gets access to. A broad
  `nodeIntegration: true` with remote content loaded is dangerous by design.
- `BrowserWindow` loading remote URLs instead of local files. Remote content with
  Node access is the classic Electron RCE pattern.
- Obfuscated/minified payloads, base64 blobs, `eval`, `Function(...)`, and code
  that is fetched and then executed at runtime.
- Telemetry SDKs and the endpoints they post to.

## Runtime (optional)

For live behavior, REA can observe an already-open Electron target
(`list_electron_targets`, `observe_javascript_runtime`). The mitmproxy network
capture (`network-capture.md`) works the same as for any app; scope it to the
Electron process name(s).

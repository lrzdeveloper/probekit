# The REA stack: inventory, discovery, config, recovery

This skill conducts REA; it does not reinstall it. Discover what's present, use
it, and only repair the specific thing that's broken.

## Discover what's installed (do this first, don't assume)

```bash
# REA MCP tools present? (they appear as mcp__rea__* in your tool list)
# Decompile engines REA can drive:
echo "$GHIDRA_INSTALL_DIR"                 # Ghidra location REA will use
ls "$GHIDRA_INSTALL_DIR/support/analyzeHeadless" 2>/dev/null
echo "$REA_JADX_MCP_JAR"                   # JADX headless jar for Android
command -v apktool jadx mitmdump tshark    # supporting tools
/usr/libexec/java_home -V 2>&1 | head      # Java (Ghidra/JADX need it)
```

If the REA MCP tools are not in your tool list at all, read the
`reverse-engineer-anything` skill — it owns connection/registration. This skill
assumes REA is reachable.

## Known-good configuration (reference, not a hard requirement)

REA selects a decompile provider via environment variables on its MCP server
registration (for Claude Code: the `rea` entry in `~/.claude.json`; for Pi:
`~/.pi/agent/mcp.json`; other clients have their own path — `rea doctor` prints
it). A configuration that worked well on an Apple-silicon Mac:

```json
"env": {
  "GHIDRA_INSTALL_DIR": "/absolute/path/to/ghidra_12.1.x_PUBLIC",
  "JAVA_HOME": "/opt/homebrew/opt/openjdk",
  "REA_JADX_MCP_JAR": "/absolute/path/to/jadx-headless-mcp-x.y.z-all.jar",
  "REA_APKTOOL_COMMAND": "/opt/homebrew/bin/apktool",
  "GHIDRA_MAXMEM": "16G",
  "REA_GHIDRA_STARTUP_TIMEOUT_MS": "1800000"
}
```

Two gotchas learned the hard way:

- **Ghidra version must match what REA supports.** REA pins a Ghidra line (e.g.
  12.1.x). A newer Homebrew Ghidra (12.2) will be rejected with
  `unsupported_version`. Download the exact supported release from the official
  NSA GitHub releases, verify its SHA-256, and point `GHIDRA_INSTALL_DIR` at it.
- **The official Ghidra zip may lack a decompiler native for your platform**
  (e.g. macOS arm64). If REA reports a missing native decompiler, build it once
  from the bundled Gradle wrapper:
  ```bash
  cd "$GHIDRA_INSTALL_DIR/support/gradle" && JAVA_HOME=<jdk> ./gradlew buildNatives
  # then copy build/os/<platform>/ artifacts next to each module's os/<platform>/
  ```

After changing REA's env, the user must reconnect the MCP server (e.g. `/mcp` in
Claude Code) — a running server keeps its old config.

## Response size & timeouts

- REA results can exceed the MCP response budget. When a tool says the result was
  saved to a file, use `jq`/`python` on that file to extract the slice you need;
  don't try to re-request the whole thing.
- First Ghidra analysis of a large binary (tens of MB) can take minutes and needs
  heap. If you hit `provider_timeout` or it's swapping, raise `GHIDRA_MAXMEM` and
  `REA_GHIDRA_STARTUP_TIMEOUT_MS` (above) rather than abandoning the analysis.
  Confirm the heap is actually in effect: `ps -axo command | grep '[j]ava.*-Xmx'`.

## Finding function names on "stripped-looking" modern binaries

Ghidra headless often won't surface Rust/Go string literals, and
`search_procedures` on a huge binary can overflow the response. The reliable
pattern:

```bash
# demangled symbols straight from the binary, filtered to the module of interest
nm -C <binary> | grep -E '<module>.*<feature>' | grep -vE 'drop_in_place|::fmt|Deserialize'
```

Take the address of the function you want and hand it to REA
(`procedure_pseudo_code` / `analyze_function`). This shell+REA combination is
what lets the audit reach real behavior instead of stopping at strings.

// Smoke tests — exercise the CLI surface without touching real agent configs.
// Run with: npm test   (node's built-in runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'cli.mjs');
// Bounded: execFileSync blocks the runner, so a hung CLI must not stall the suite.
const run = (args, opts = {}) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30_000, ...opts });
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

// Run against a throwaway HOME with no engine env, so real agent configs and
// machine-specific engines never affect (or get touched by) the tests.
function withTempHome(fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'probekit-test-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, '.cache'), PROBEKIT_NO_UPDATE_CHECK: '1' };
  for (const k of ['JAVA_HOME', 'GHIDRA_INSTALL_DIR', 'REA_JADX_MCP_JAR']) delete env[k];
  try { return fn(home, env); } finally { rmSync(home, { recursive: true, force: true }); }
}

test('--version prints the package version', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(run(['--version']).trim(), pkg.version);
});

test('help lists the commands', () => {
  const out = stripAnsi(run(['help']));
  for (const cmd of ['init', 'install', 'doctor', 'setup-engines', 'uninstall'])
    assert.match(out, new RegExp(`^ +${cmd} +\\S`, 'm'), `missing command entry: ${cmd}`);
});

test('doctor runs and reports the engine check', () => withTempHome((home, env) => {
  const out = run(['doctor'], { env });
  assert.match(out, /Engine check/);
  assert.match(out, /MCP wiring/);
}));

test('uninstall removes only the real Codex REA tables', () => withTempHome((home, env) => {
  const file = path.join(home, '.codex', 'config.toml');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, [
    'model = "o3"',
    '# [mcp_servers.rea] (just a comment)',
    'notes = """',
    '[mcp_servers.rea]',
    '"""',
    '',
    '[mcp_servers."rea"] # REA',
    'args = [',
    '  "x",',
    ']',
    '',
    '[mcp_servers.rea.env]',
    'A = "1"',
    '',
    '[mcp_servers.keep]',
    'command = "keep"',
    '',
  ].join('\n'));
  assert.match(stripAnsi(run(['uninstall'], { env })), /removed REA MCP from Codex/);
  const after = readFileSync(file, 'utf8');
  assert.match(after, /notes = """\n\[mcp_servers\.rea\]\n"""/); // value text untouched
  assert.match(after, /\[mcp_servers\.keep\]\ncommand = "keep"/);
  assert.doesNotMatch(after, /"rea"|\.env|"x"/);
}));

test('an unknown command falls back to help', () => {
  assert.match(run(['wat']), /\[command\]/);
});

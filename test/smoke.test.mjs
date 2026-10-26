// Smoke tests — exercise the CLI surface without touching real agent configs.
// Run with: npm test   (node's built-in runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'cli.mjs');
const run = (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8' });

test('--version prints the package version', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(run('--version').trim(), pkg.version);
});

test('help lists the commands', () => {
  const out = run('help');
  for (const cmd of ['init', 'install', 'doctor', 'setup-engines', 'uninstall'])
    assert.match(out, new RegExp(cmd));
});

test('doctor runs and reports the engine check', () => {
  const out = run('doctor');
  assert.match(out, /Engine check/);
  assert.match(out, /MCP wiring/);
});

test('an unknown command falls back to help', () => {
  assert.match(run('wat'), /npx probekit/);
});

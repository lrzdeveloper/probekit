#!/usr/bin/env node
// probekit installer.
// Registers the REA MCP server (and, where supported, the probekit skill) into
// whichever AI agents you have. It detects them and lets you choose.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as readline from 'node:readline/promises';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { parse as jsoncParse, modify as jsoncModify, applyEdits } from 'jsonc-parser';
import { parse as tomlParse } from 'smol-toml';

// Surgically set/remove a key in a JSON *or* JSONC file, preserving comments and
// formatting. value === undefined removes it. Returns the new text, or null if
// the file has real syntax errors (so we never clobber it).
const JSONC_FMT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
function jsoncEdit(text, keyPath, value) {
  let t = text.trim() ? text : '{}';
  if (text.trim()) { const errs = []; jsoncParse(t, errs, { allowTrailingComma: true }); if (errs.length) return null; }
  return applyEdits(t, jsoncModify(t, keyPath, value, JSONC_FMT));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Run an external command with NO stdin (so an interactive prompt gets EOF and
// can't hang us) and a hard timeout, without blocking the event loop (clack
// spinners keep animating). The child gets its own process group so a timeout
// kills the whole tree (npx → npm → node), and we resolve only once it's gone.
// Resolves 'ok' | 'failed' | 'timeout'.
const killTree = child => {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {}
};
const run = (cmd, args, { ms = 90000, stdio = 'ignore' } = {}) => new Promise(resolve => {
  let child, timedOut = false;
  try { child = spawn(cmd, args, { stdio, detached: process.platform !== 'win32' }); }
  catch { return resolve('failed'); }
  const t = setTimeout(() => { timedOut = true; killTree(child); }, ms);
  child.on('error', () => { clearTimeout(t); resolve('failed'); });
  child.on('exit', code => { clearTimeout(t); resolve(timedOut ? 'timeout' : code === 0 ? 'ok' : 'failed'); });
});

const HOME = os.homedir();
const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SKILL_SRC = path.join(PKG_ROOT, 'skills', 'probekit');
const REA_TOOLS = path.join(HOME, '.rea-tools');
const REA_VERSION = 'rea-agents@6.8.0';
const REA_NODE_REQ = '^22.23.4 || ^24.22.1 || >=26.12.1'; // rea-agents@6.8.0 engines.node
const GHIDRA_SERIES = /^ghidra_12\.1\.\d+_PUBLIC$/;        // REA requires the 12.1.x series

const c = { dim: s => `\x1b[2m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m` };
const tilde = x => (x || '').replace(HOME, '~');

// ---- small shell + fs helpers ----
const sh = cmd => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).toString().trim(); } catch { return ''; } };
const which = bin => sh(`command -v ${bin}`);
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const readText = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
// Replace a file atomically: write + fsync a temp sibling, keep the original's
// mode, refuse if the file changed since we read it (expected = the text we
// read, null = it didn't exist, undefined = don't check), then rename over it.
// A symlinked config is written through to its real target so the link survives.
function writeAtomic(file, text, expected) {
  let target = file, mode = null;
  try { target = fs.realpathSync(file); mode = fs.statSync(target).mode & 0o7777; } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.probekit-${process.pid}-${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', mode ?? 0o666);
    try { if (mode !== null) fs.fchmodSync(fd, mode); fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (expected !== undefined && readText(target) !== expected) throw new Error(`${tilde(file)} changed while probekit was editing it`);
    fs.renameSync(tmp, target);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}
const backup = p => { if (!exists(p)) return null; const b = `${p}.bak.${Date.now()}`; fs.copyFileSync(p, b); return b; };
const globFirst = (dir, re) => { try { return fs.readdirSync(dir).filter(f => re.test(f)).sort().reverse().map(f => path.join(dir, f))[0] || ''; } catch { return ''; } };

// ---- agent targets: detected dynamically, chosen by the user ----
// Every selected agent ALWAYS gets the REA MCP (the skill is useless without it).
// The skill is delivered either natively (skillDir, for agents that read
// SKILL.md: Claude Code, Pi) or via the `skills` CLI (skillsAgent). An agent
// with neither would be MCP-only.
const AGENTS = [
  { id: 'claude-code', label: 'Claude Code',
    detect: () => exists(path.join(HOME, '.claude.json')) || exists(path.join(HOME, '.claude')),
    mcpFile: path.join(HOME, '.claude.json'),
    skillDir: path.join(HOME, '.claude', 'skills', 'probekit') },
  { id: 'pi', label: 'Pi agent',
    detect: () => exists(path.join(HOME, '.pi', 'agent')),
    mcpFile: path.join(HOME, '.pi', 'agent', 'mcp.json'), mcpType: 'stdio',
    skillDir: path.join(HOME, '.pi', 'agent', 'skills', 'probekit') },
  { id: 'cursor', label: 'Cursor',
    detect: () => exists(path.join(HOME, '.cursor')),
    mcpFile: path.join(HOME, '.cursor', 'mcp.json'), skillsAgent: 'cursor' },
  { id: 'windsurf', label: 'Windsurf',
    detect: () => exists(path.join(HOME, '.codeium', 'windsurf')),
    mcpFile: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), skillsAgent: 'windsurf' },
  { id: 'gemini-cli', label: 'Gemini CLI',
    detect: () => exists(path.join(HOME, '.gemini', 'settings.json')),
    mcpFile: path.join(HOME, '.gemini', 'settings.json'), skillsAgent: 'gemini-cli' },
  { id: 'github-copilot', label: 'GitHub Copilot CLI',
    detect: () => exists(path.join(HOME, '.copilot')),
    mcpFile: path.join(HOME, '.copilot', 'mcp-config.json'), skillsAgent: 'github-copilot' },
  { id: 'antigravity', label: 'Antigravity',
    detect: () => exists(path.join(HOME, '.gemini', 'antigravity')),
    mcpFile: path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json'), skillsAgent: 'antigravity' },
  // Different MCP config shapes, one verified adapter each (see installMcp).
  { id: 'codex', label: 'Codex', format: 'codex',
    detect: () => exists(path.join(HOME, '.codex')),
    mcpFile: path.join(HOME, '.codex', 'config.toml'), skillsAgent: 'codex' },
  { id: 'zed', label: 'Zed', format: 'zed',
    detect: () => exists(path.join(HOME, '.config', 'zed')),
    mcpFile: path.join(HOME, '.config', 'zed', 'settings.json'), skillsAgent: 'zed' },
  { id: 'opencode', label: 'OpenCode', format: 'opencode',
    detect: () => exists(path.join(HOME, '.config', 'opencode')),
    mcpFile: path.join(HOME, '.config', 'opencode', 'opencode.json'), skillsAgent: 'opencode' },
  { id: 'amp', label: 'Amp', format: 'amp',
    detect: () => exists(path.join(HOME, '.config', 'amp')),
    mcpFile: path.join(HOME, '.config', 'amp', 'settings.json'), skillsAgent: 'amp' },
];
const SKILLS_REPO = 'lrzdeveloper/probekit'; // for `npx skills add <repo>`

// Where `npx skills add -g` drops the skill per agent (from the skills docs).
// Used to verify/remove it directly without the CLI.
const SKILL_GLOBAL = {
  cursor: ['.cursor', 'skills'], windsurf: ['.codeium', 'windsurf', 'skills'],
  'gemini-cli': ['.gemini', 'skills'], 'github-copilot': ['.copilot', 'skills'],
  antigravity: ['.gemini', 'antigravity', 'skills'], codex: ['.agents', 'skills'],
  zed: ['.agents', 'skills'], opencode: ['.config', 'opencode', 'skills'], amp: ['.config', 'agents', 'skills'],
};
for (const a of AGENTS) if (a.skillsAgent && SKILL_GLOBAL[a.skillsAgent]) a.skillGlobalDir = path.join(HOME, ...SKILL_GLOBAL[a.skillsAgent], 'probekit');
const byId = id => AGENTS.find(a => a.id === id);
const detected = () => AGENTS.filter(a => a.detect());

// ---- engine discovery (portable, not hardcoded to one machine) ----
function findJava() {
  const jh = sh('/usr/libexec/java_home 2>/dev/null');
  if (jh) return jh;
  const brew = sh('brew --prefix openjdk 2>/dev/null');
  if (brew && exists(brew)) return brew;
  return process.env.JAVA_HOME || '';
}
const findGhidra = () => globFirst(REA_TOOLS, GHIDRA_SERIES) || (GHIDRA_SERIES.test(path.basename(process.env.GHIDRA_INSTALL_DIR || '')) ? process.env.GHIDRA_INSTALL_DIR : '');
const findJadxJar = () => globFirst(REA_TOOLS, /^jadx-headless-mcp-.*-all\.jar$/) || process.env.REA_JADX_MCP_JAR || '';
function totalMemGB() {
  if (process.platform === 'darwin') { const b = +sh('sysctl -n hw.memsize'); return b ? b / 1024 ** 3 : 0; }
  try { const m = /MemTotal:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8')); return m ? +m[1] / 1024 ** 2 : 0; } catch { return 0; }
}
const ghidraMemG = () => { const t = totalMemGB(); return t ? Math.max(4, Math.min(16, Math.floor(t / 2))) : 8; };

// Does a Node version satisfy what the pinned REA needs? (Node spawns the MCP.)
function nodeSatisfiesReaV(ver) {
  const [maj, min, pat] = String(ver || '').split('.').map(Number);
  const ge = (a, b, d) => maj > a || (maj === a && (min > b || (min === b && pat >= d)));
  if (maj === 22) return ge(22, 23, 4);
  if (maj === 24) return ge(24, 22, 1);
  if (maj >= 26) return ge(26, 12, 1);
  return false; // 23 and 25 are unsupported
}
const nodeSatisfiesRea = () => nodeSatisfiesReaV(process.versions.node);
// Is the node on PATH managed by Homebrew? (only then can we safely `brew upgrade node`)
const nodeViaBrew = () => { const b = sh('brew --prefix 2>/dev/null'); const n = which('node'); return !!b && !!n && n.startsWith(b); };

function buildEnv(memOverride) {
  const env = {};
  const jar = findJadxJar(); if (jar) env.REA_JADX_MCP_JAR = jar;
  const java = findJava(); if (java) env.JAVA_HOME = java;
  const apk = which('apktool'); if (apk) env.REA_APKTOOL_COMMAND = apk;
  const gh = findGhidra();
  if (gh) { env.GHIDRA_INSTALL_DIR = gh; env.GHIDRA_MAXMEM = memOverride || `${ghidraMemG()}G`; env.REA_GHIDRA_STARTUP_TIMEOUT_MS = '1800000'; }
  return env;
}

// ---- per-agent actions ----
// Each agent's config uses a different shape; mcpKeyFor + installMcp/removeMcp
// write the one that agent actually understands (verified against each vendor's
// docs). Codex is TOML (edited by the helpers below).
const mcpKeyFor = fmt => fmt === 'amp' ? 'amp.mcpServers' : fmt === 'zed' ? 'context_servers' : fmt === 'opencode' ? 'mcp' : 'mcpServers';

// ---- Codex config.toml: TOML-aware edits that keep the user's comments ----
// Real table headers only: we track strings (incl. multi-line """ / ''') and
// open [ ] / { } in values, so header-looking text inside a value never counts.
// Returns [{ line, path }]; path is the unquoted dotted key ([] if unparseable).
function tomlHeaderPath(line) {
  let s = line.trim();
  const arr = s.startsWith('[[');
  s = s.slice(arr ? 2 : 1);
  const keys = [];
  for (;;) {
    s = s.trimStart();
    let m;
    if ((m = /^[A-Za-z0-9_-]+/.exec(s))) keys.push(m[0]);
    else if ((m = /^"(?:[^"\\]|\\.)*"/.exec(s))) { try { keys.push(JSON.parse(m[0])); } catch { return []; } }
    else if ((m = /^'[^']*'/.exec(s))) keys.push(m[0].slice(1, -1));
    else return [];
    s = s.slice(m[0].length).trimStart();
    if (s[0] === '.') { s = s.slice(1); continue; }
    return s.startsWith(arr ? ']]' : ']') ? keys : [];
  }
}
function tomlHeaders(lines) {
  const out = [];
  let ml = null, depth = 0; // ml = open multi-line string delimiter
  lines.forEach((line, n) => {
    if (!ml && depth <= 0 && line.trimStart()[0] === '[') { out.push({ line: n, path: tomlHeaderPath(line) }); return; }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ml) {
        if (ml === '"""' && ch === '\\') i++;
        else if (line.startsWith(ml, i)) { while (line[i + 3] === ml[0]) i++; i += 2; ml = null; }
      } else if (ch === '#') break;
      else if (line.startsWith('"""', i) || line.startsWith("'''", i)) { ml = line.slice(i, i + 3); i += 2; }
      else if (ch === '"') { for (i++; i < line.length && line[i] !== '"'; i++) if (line[i] === '\\') i++; }
      else if (ch === "'") { i = line.indexOf("'", i + 1); if (i < 0) break; }
      else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
    }
  });
  return out;
}
// Drop every [mcp_servers.rea] / [mcp_servers.rea.*] table (header up to the
// next header). Returns the kept lines and where the first REA table was (-1).
function tomlStripRea(text) {
  const lines = text.split('\n'), hs = tomlHeaders(lines), drop = new Set();
  let at = -1;
  hs.forEach((h, k) => {
    if (h.path[0] !== 'mcp_servers' || h.path[1] !== 'rea') return;
    if (at < 0) at = h.line;
    for (let n = h.line, end = hs[k + 1]?.line ?? lines.length; n < end; n++) drop.add(n);
  });
  return { lines: lines.filter((_, n) => !drop.has(n)), at };
}
const tomlRea = text => { try { return tomlParse(text).mcp_servers?.rea; } catch { return undefined; } };
const tomlValid = text => { try { tomlParse(text); return true; } catch { return false; } };

// Read a config for editing: null if absent; throws if present but unreadable
// (so we never mistake it for empty and overwrite it).
const readConfig = f => exists(f) ? fs.readFileSync(f, 'utf8') : null;

async function installMcp(agent, mem) {
  const env = buildEnv(mem);
  const args = ['-y', REA_VERSION, 'mcp'];
  const fmt = agent.format || 'mcpServers';
  try {
    const orig = readConfig(agent.mcpFile), text = orig ?? '';
    let next;
    if (fmt === 'codex') {
      // The `codex` CLI is often a shim (e.g. cmux) that no-ops outside its own
      // terminal, so we edit config.toml directly: drop any existing REA table
      // and write the current one in its place (or at the end).
      if (!tomlValid(text)) return { ok: false, hint: `the file has TOML syntax errors, so add it by hand to ${tilde(agent.mcpFile)}` };
      const q = s => JSON.stringify(String(s)); // TOML basic string (JSON-compatible escaping)
      const block = ['[mcp_servers.rea]', 'command = "npx"', `args = [ ${args.map(q).join(', ')} ]`, 'startup_timeout_sec = 60', ''];
      const envEntries = Object.entries(env);
      if (envEntries.length) block.push('[mcp_servers.rea.env]', ...envEntries.map(([k, v]) => `${k} = ${q(v)}`), '');
      const { lines, at } = tomlStripRea(text);
      if (at >= 0) lines.splice(at, 0, ...block);
      else {
        while (lines.length && !lines.at(-1).trim()) lines.pop();
        lines.push(...(lines.length ? [''] : []), ...block);
      }
      next = lines.join('\n');
      if (tomlRea(next)?.command !== 'npx')
        return { ok: false, hint: `REA is defined in ${tilde(agent.mcpFile)} in a form probekit can't safely rewrite, so edit it by hand` };
    } else {
      // JSON / JSONC: edit in place with jsonc-parser so comments and formatting
      // survive (Zed/Amp/VS Code files can have comments). Only the `rea` key
      // changes, even in big files like ~/.claude.json.
      const value = fmt === 'opencode' ? { type: 'local', command: ['npx', ...args], environment: env, enabled: true }
        : fmt === 'zed' ? { source: 'custom', command: 'npx', args, env }
        : { ...(agent.mcpType ? { type: agent.mcpType } : {}), command: 'npx', args, env }; // mcpServers + amp
      next = jsoncEdit(text, [mcpKeyFor(fmt), 'rea'], value);
      if (next === null) return { ok: false, hint: `the file has JSON syntax errors, so add it by hand to ${tilde(agent.mcpFile)}` };
    }
    if (next === orig) return { ok: true, note: 'already configured' };
    const b = backup(agent.mcpFile);
    writeAtomic(agent.mcpFile, next, orig);
    return { ok: true, backup: b };
  } catch (e) {
    return { ok: false, hint: `${e.message}. Re-run probekit or add it by hand to ${tilde(agent.mcpFile)}` };
  }
}
// Throws (with a message for the user) if REA is there but can't be removed safely.
function removeMcp(agent) {
  const fmt = agent.format || 'mcpServers';
  const orig = readConfig(agent.mcpFile);
  if (orig === null) return false;
  let next;
  if (fmt === 'codex') {
    if (!tomlRea(orig)) return false;
    next = tomlStripRea(orig).lines.join('\n');
    if (!tomlValid(next) || tomlRea(next)) throw new Error(`remove mcp_servers.rea from ${tilde(agent.mcpFile)} by hand`);
  } else {
    const key = mcpKeyFor(fmt);
    const obj = jsoncParse(orig) || {};
    if (!(obj[key] && obj[key].rea)) return false;
    next = jsoncEdit(orig, [key, 'rea'], undefined);
    if (next === null) return false;
  }
  backup(agent.mcpFile);
  writeAtomic(agent.mcpFile, next, orig);
  return true;
}
// Stage the new copy beside the live one, verify it, then swap. The old copy
// is only deleted once the new one is in place (and is restored on failure).
function installSkillInto(agent) {
  if (!agent.skillDir) return null;
  const dst = agent.skillDir, stage = `${dst}.probekit-new`, old = `${dst}.probekit-old`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  try {
    fs.cpSync(SKILL_SRC, stage, { recursive: true });
    if (!exists(path.join(stage, 'SKILL.md'))) throw new Error(`incomplete skill copy (no SKILL.md) from ${SKILL_SRC}`);
    if (exists(dst)) fs.renameSync(dst, old);
    try { fs.renameSync(stage, dst); }
    catch (e) { if (exists(old)) fs.renameSync(old, dst); throw e; }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  fs.rmSync(old, { recursive: true, force: true });
  return dst;
}
// Deliver the skill: natively (SKILL.md copy) for Claude Code/Pi, or via the
// vercel-labs `skills` CLI for the rest. Returns {how} or null (MCP-only agent).
async function installSkillFor(agent) {
  if (agent.skillDir) {
    try { installSkillInto(agent); return { how: 'native', where: agent.skillDir }; }
    catch (e) { return { how: 'native-failed', error: e.message }; }
  }
  if (agent.skillsAgent) {
    const res = await run('npx', ['-y', 'skills@latest', 'add', SKILLS_REPO, '--skill', 'probekit', '-a', agent.skillsAgent, '-g', '-y']);
    return { how: res === 'ok' ? 'skills-cli' : 'skills-cli-failed' };
  }
  return null; // no skill mechanism
}
function reaInstalled(agent) {
  const fmt = agent.format || 'mcpServers';
  const text = readText(agent.mcpFile);
  if (text === null) return false;
  if (fmt === 'codex') return !!tomlRea(text);
  return !!(jsoncParse(text) || {})[mcpKeyFor(fmt)]?.rea;
}
const skillDirOf = agent => (agent.skillDir && exists(path.join(agent.skillDir, 'SKILL.md'))) ? agent.skillDir
  : (agent.skillGlobalDir && exists(path.join(agent.skillGlobalDir, 'SKILL.md'))) ? agent.skillGlobalDir : null;
const skillInstalled = agent => !!skillDirOf(agent);
// Agents only load/unload probekit on restart, so always tell the user to reload.
const reloadNote = (labels, appearing) => c.dim(`\n  Restart / reconnect ${labels.length ? labels.join(', ') : 'your agent(s)'} ${appearing ? 'so probekit (its skill + REA tools) shows up.' : 'so probekit is fully unloaded.'}\n`);

function doctor() {
  const java = findJava(), gh = findGhidra(), jar = findJadxJar();
  const rows = [
    [`node (REA needs ${REA_NODE_REQ})`, nodeSatisfiesRea(), nodeSatisfiesRea() ? process.versions.node : `${process.versions.node}: update Node so the REA MCP can run`],
    ['java (JDK 17+)', !!java, java || 'brew install openjdk'],
    ['Ghidra 12.1.x', !!gh, gh || 'probekit setup-engines   (12.2+ is rejected by REA)'],
    ['jadx MCP jar', !!jar, jar || `place jadx-headless-mcp-*-all.jar in ${tilde(REA_TOOLS)} (ships with REA engine setup)`],
    ['apktool', !!which('apktool'), which('apktool') || 'brew install apktool'],
    ['mitmproxy', !!which('mitmdump'), which('mitmdump') || 'brew install mitmproxy'],
  ];
  console.log(c.b('\nEngine check\n'));
  for (const [name, ok, hint] of rows)
    console.log(`  ${ok ? c.g('✓') : c.r('✗')} ${name.padEnd(18)} ${ok ? c.dim(hint) : c.y(hint)}`);
  console.log(c.b('\nMCP wiring\n'));
  for (const a of AGENTS) {
    const det = a.detect();
    const bits = [reaInstalled(a) ? c.g('REA ✓') : det ? c.r('REA ✗') : c.dim('REA -')];
    if (a.skillDir || a.skillGlobalDir) bits.push(skillInstalled(a) ? c.g('skill ✓') : det ? c.r('skill ✗') : c.dim('skill -'));
    else bits.push(c.dim('(MCP only)'));
    console.log(`  ${det ? c.g('●') : c.dim('○')} ${a.label.padEnd(15)} ${bits.join('   ')}${det ? '' : c.dim('  not detected')}`);
  }
  console.log('');
}

// Non-interactive apply. opts: { agents: [ids]|undefined (default detected), mem }
async function install(opts = {}) {
  const agents = (opts.agents ? opts.agents.map(byId).filter(Boolean) : detected());
  const mem = opts.mem;
  console.log(c.b('\nprobekit install\n'));
  if (!agents.length) { console.log(c.y('  No agents selected or detected, so there is nothing to do.\n')); return; }
  for (const a of agents) {
    const m = await installMcp(a, mem);
    if (m.ok) console.log(`  ${c.g('✓')} REA MCP → ${tilde(a.mcpFile)} ${m.note ? c.dim(`(${m.note})`) : m.backup ? c.dim(`(backup ${path.basename(m.backup)})`) : ''}`);
    else {
      // The skill is useless without REA's tools, so don't install it half-way.
      console.log(c.y(`  ! REA MCP not set for ${a.label}: ${m.hint}`));
      console.log(c.y(`  ! skill skipped for ${a.label} until the REA MCP is configured. Re-run \`probekit install\` once that's fixed.`));
      continue;
    }
    const sk = await installSkillFor(a);
    if (sk?.how === 'native') console.log(`  ${c.g('✓')} skill  → ${tilde(sk.where)}`);
    else if (sk?.how === 'native-failed') console.log(c.y(`  ! skill not installed (${sk.error}). Re-run \`probekit install\`.`));
    else if (sk?.how === 'skills-cli') console.log(`  ${c.g('✓')} skill  → via skills CLI (${a.skillsAgent})`);
    else if (sk?.how === 'skills-cli-failed') console.log(c.y(`  ! skill not installed. Run: npx skills add ${SKILLS_REPO} -a ${a.skillsAgent}`));
  }
  if (!nodeSatisfiesRea()) console.log(c.y(`\n  ⚠ Node ${process.versions.node} is too old for REA (${REA_NODE_REQ}).\n    Update Node, then reconnect the MCP. Until then REA will report unhealthy.`));
  const env = buildEnv(mem);
  if (!env.GHIDRA_INSTALL_DIR || !env.REA_JADX_MCP_JAR) console.log(c.y('\n  Some engines are missing. Run `probekit setup-engines`.'));
  console.log(reloadNote(agents.map(a => a.label), true));
  doctor();
}

// Guided, interactive setup with @clack/prompts: a searchable multiselect over
// agents (type to filter, space to toggle), spinners for the apply. Every
// selected agent ALWAYS gets the REA MCP (+ the skill). Falls back to a plain
// install when not a TTY (piped, CI).
async function init() {
  if (!process.stdin.isTTY) { console.log(c.dim('(not a terminal, running install for the detected agents)')); return install({}); }
  const bail = (m = 'Aborted. Nothing was changed.') => { p.cancel(m); };
  try {
    p.intro(c.b(`probekit v${VERSION}`) + c.dim('  app security and reverse-engineering stack'));

    p.note([
      `${nodeSatisfiesRea() ? '✓' : '✗'} node ${process.versions.node}${nodeSatisfiesRea() ? '' : '  (too old for REA)'}`,
      `${findGhidra() ? '✓' : '✗'} Ghidra 12.1.x`,
      `${findJadxJar() ? '✓' : '✗'} jadx`,
      `${which('apktool') ? '✓' : '✗'} apktool`,
      `${which('mitmdump') ? '✓' : '✗'} mitmproxy`,
    ].join('\n'), 'Engines');

    const sel = await p.autocompleteMultiselect({
      message: 'Which agents get probekit (REA MCP + skill)? Type to search, space to toggle.',
      placeholder: 'Search agents…',
      options: AGENTS.map(a => ({ value: a.id, label: a.label, hint: reaInstalled(a) ? 'configured ✓' : a.detect() ? 'detected' : undefined })),
      initialValues: detected().map(a => a.id),
      required: true,
    });
    if (p.isCancel(sel)) return bail();
    const agents = sel.map(byId).filter(Boolean);

    const memRaw = await p.text({ message: 'Ghidra heap size', initialValue: `${ghidraMemG()}G`, placeholder: `${ghidraMemG()}G` });
    if (p.isCancel(memRaw)) return bail();
    let mem = String(memRaw).trim();
    if (!/g$/i.test(mem)) mem = (mem.replace(/[^0-9]/g, '') || ghidraMemG()) + 'G';

    const missing = [!findGhidra() && 'Ghidra 12.1.x', !findJadxJar() && 'jadx', !which('apktool') && 'apktool', !which('mitmdump') && 'mitmproxy'].filter(Boolean);
    let runEngines = false;
    if (missing.length) {
      const r = await p.confirm({ message: `Install missing engines now (${missing.join(', ')})?`, initialValue: false });
      if (p.isCancel(r)) return bail();
      runEngines = r;
    }

    let upgradeNode = false;
    if (!nodeSatisfiesRea() && nodeViaBrew()) {
      const r = await p.confirm({ message: `Node ${process.versions.node} is too old for REA. Run \`brew upgrade node\` now? (system-wide)`, initialValue: false });
      if (p.isCancel(r)) return bail();
      upgradeNode = r;
    }

    p.note(
      agents.map(a => `• ${a.label} → REA MCP + skill`).join('\n')
      + (runEngines ? '\n• install missing engines first' : '')
      + (upgradeNode ? '\n• brew upgrade node (system-wide) first' : '')
      + `\n\nGhidra heap ${mem}; every config is backed up first.`,
      'Will apply');
    const go = await p.confirm({ message: 'Proceed?', initialValue: true });
    if (p.isCancel(go) || !go) return bail();

    if (runEngines) await setupEngines();
    if (upgradeNode) {
      const s = p.spinner(); s.start('brew upgrade node (system-wide)');
      const res = await run('brew', ['upgrade', 'node'], { ms: BREW_MS });
      s.stop(res === 'ok' ? 'Node upgraded' : `brew upgrade node ${res === 'timeout' ? 'timed out' : 'failed'}, upgrade Node manually`);
    }
    const done = [], manual = [];
    for (const a of agents) {
      const was = reaInstalled(a);
      const s = p.spinner(); s.start(`${was ? 'Updating' : 'Configuring'} ${a.label}`);
      // The skill needs REA's tools, so it only goes in once the MCP is configured.
      const minSpin = sleep(400);
      const m = await installMcp(a, mem);
      const sk = m.ok ? await installSkillFor(a) : null;
      await minSpin;
      const mcpTag = m.ok ? (m.note ? `REA MCP (${m.note})` : 'REA MCP') : 'REA MCP needs a manual step';
      const skTag = !m.ok ? ' (skill skipped until the MCP is configured)'
        : sk?.how === 'native' ? ' + skill'
        : sk?.how === 'native-failed' ? ` (skill failed: ${sk.error})`
        : sk?.how === 'skills-cli' ? ' + skill (via skills CLI)'
        : sk?.how === 'skills-cli-failed' ? ' (skill failed, run `npx skills add` manually)'
        : '';
      s.stop(`${a.label}: ${mcpTag}${skTag}`);
      if (m.ok) done.push(a.label);
      else { manual.push({ label: a.label, hint: m.hint }); p.log.warn(`${a.label}: ${m.hint}`); }
    }

    const nv = (sh('node -v') || '').replace(/^v/, '');
    const nodeOkNow = upgradeNode ? nodeSatisfiesReaV(nv) : nodeSatisfiesRea();
    if (upgradeNode && nodeOkNow) p.log.success(`Node is now ${nv}, which REA supports.`);

    const steps = [];
    if (done.length) steps.push(`Restart / reconnect ${done.join(', ')} so probekit loads.`);
    if (manual.length) steps.push(`Finish by hand for ${manual.map(x => x.label).join(', ')} (commands shown above).`);
    if (!nodeOkNow) steps.push(`Update Node to ${REA_NODE_REQ}${nodeViaBrew() ? ' (run \`brew upgrade node\`)' : ' via your Node manager'}. REA stays unhealthy until then.`);
    if (steps.length) p.note(steps.map((s, i) => `${c.dim(`${i + 1}.`)} ${s}`).join('\n'), 'Next steps');
    p.note(`${c.b(`npx skills add ${SKILLS_REPO}`)}\n${c.dim('Installs the probekit skill on any of 80+ other coding agents.')}`, 'Add probekit elsewhere');
    p.outro(done.length
      ? c.g(`✓ REA MCP ready on ${done.join(', ')}`) + (manual.length ? c.y(`  ·  ${manual.length} need a manual step`) : '')
      : c.y('No agent is fully configured. See the manual steps above.'));
    return;
  } catch (e) {
    if (e && (e.code === 'ABORT_ERR' || e.code === 'ERR_USE_AFTER_CLOSE')) return bail();
    throw e;
  }
}

const BREW_MS = 15 * 60 * 1000; // generous: big bottles (openjdk) on slow links
async function setupEngines() {
  const brew = which('brew');
  console.log(c.b('\nsetup-engines\n'));
  if (brew) {
    for (const [f, probe] of [['openjdk', 'java'], ['apktool', 'apktool'], ['mitmproxy', 'mitmdump']]) {
      if (which(probe)) { console.log(`  ${c.g('✓')} ${f} already present`); continue; }
      console.log(c.dim(`  brew install ${f} ...`));
      const res = await run('brew', ['install', f], { ms: BREW_MS, stdio: ['ignore', 'inherit', 'inherit'] });
      if (res === 'timeout') console.log(c.y(`  ! brew install ${f} timed out after ${BREW_MS / 60000} min and was stopped. Run \`brew install ${f}\` yourself (if brew reports a lock, wait for the other brew process to finish or end it first).`));
      else if (res !== 'ok') console.log(c.y(`  ! brew install ${f} failed, install it manually`));
    }
  } else {
    console.log(c.y('  Homebrew not found. Install openjdk, apktool and mitmproxy with your package manager.'));
  }
  if (findGhidra()) console.log(`  ${c.g('✓')} Ghidra 12.1.x already present`);
  else ghidraHelp();
  if (!findJadxJar()) console.log(c.y(`\n  jadx MCP jar not found. It is provisioned by REA's own engine setup; place\n  jadx-headless-mcp-*-all.jar in ${tilde(REA_TOOLS)} and re-run \`probekit install\`.`));
  console.log('');
}

function ghidraHelp() {
  console.log(c.y('\n  Ghidra 12.1.x not found. REA rejects 12.2+, so a brew install of the latest\n  will not work. Install the pinned release:'));
  console.log(c.dim(`    1. Download ghidra_12.1.x_PUBLIC from
       https://github.com/NationalSecurityAgency/ghidra/releases
    2. Unzip into ${tilde(REA_TOOLS)}/ (so you get ${tilde(REA_TOOLS)}/ghidra_12.1.x_PUBLIC/)
    3. If the decompiler native is missing for your CPU, build it once:
         <ghidra>/support/buildNatives
    4. Re-run \`probekit install\` to wire the path into the MCP env.`));
}

function uninstall() {
  console.log(c.b('\nuninstall (config only, engines are left in place)\n'));
  const touched = [];
  for (const a of AGENTS) {
    let hit = false;
    try { if (removeMcp(a)) { console.log(`  ${c.g('✓')} removed REA MCP from ${a.label}`); hit = true; } }
    catch (e) { console.log(c.y(`  ! REA MCP not removed from ${a.label}: ${e.message}`)); }
    const skdir = skillDirOf(a); // native or skills-CLI global dir, removed directly (no npx, no hang)
    if (skdir) { fs.rmSync(skdir, { recursive: true, force: true }); console.log(`  ${c.g('✓')} removed skill from ${tilde(skdir)}`); hit = true; }
    if (hit) touched.push(a.label);
  }
  if (!touched.length) { console.log(c.dim('  Nothing to remove: probekit is not set up in any agent.\n')); return; }
  console.log(reloadNote(touched, false));
}

function help() {
  console.log(`
${c.b('probekit')} v${VERSION}: installer for an app security and reverse-engineering stack

  ${c.b('probekit')} [command]   ${c.dim('(install: npx @lrzdeveloper/probekit)')}

  (no command)   Guided interactive setup (same as 'init')
  init           Guided interactive setup: detect agents, choose, confirm, apply
  install        Non-interactive install for all detected agents
  doctor         Show the engines and, for each agent, whether REA and the skill are set up
  setup-engines  Install the analysis engines (brew where possible; Ghidra guided)
  uninstall      Remove the REA MCP entries and the probekit skill from all agents
  help           This message

  Supported agents: ${AGENTS.map(a => a.label).join(', ')}
`);
}

const VERSION = (() => { try { return readJson(path.join(PKG_ROOT, 'package.json')).version || '0.0.0'; } catch { return '0.0.0'; } })();

// ---- update check: daily-cached, fail-silent, off in CI; offers to apply ----
const semverGt = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; } return false; };
const isSemver = v => typeof v === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/.test(v);
async function latestVersion() {
  // User-owned private cache (not shared /tmp, where another user could plant
  // a symlink or a fake cache); written atomically by rename, never followed.
  const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'probekit');
  const cacheFile = path.join(cacheDir, 'update-check.json');
  const cc = readJson(cacheFile);
  if (cc.at && Date.now() - cc.at < 864e5 && isSemver(cc.v)) return cc.v;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 1500);
  try {
    const r = await fetch('https://registry.npmjs.org/@lrzdeveloper%2Fprobekit/latest', { signal: ac.signal });
    if (!r.ok) return null;
    const v = (await r.json()).version; // still under the deadline: a stalled body aborts too
    if (!isSemver(v)) return null;
    try { fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 }); writeAtomic(cacheFile, JSON.stringify({ at: Date.now(), v }) + '\n'); } catch {}
    return v;
  } catch { return null; }
  finally { clearTimeout(t); }
}
async function notifyUpdate() {
  if (!process.stdout.isTTY || process.env.CI || process.env.PROBEKIT_NO_UPDATE_CHECK) return;
  const l = await latestVersion();
  if (!l || !semverGt(l, VERSION)) return;
  console.log(c.y(`\n  ▲ probekit ${l} is available (you have ${VERSION}).`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`  Update now? ${c.dim('(y/N)')}: `)).trim().toLowerCase();
    rl.close();
    if (!a.startsWith('y')) { console.log(c.dim('  Later: `npm i -g @lrzdeveloper/probekit@latest`, or just run `npx @lrzdeveloper/probekit@latest`.')); return; }
    console.log(c.dim('  Updating globally via npm…'));
    try { execSync('npm install -g @lrzdeveloper/probekit@latest', { stdio: 'inherit' }); console.log(c.g('  Updated. Run `probekit` again to use the new version.')); }
    catch { console.log(c.y('  Update failed. Run `npm i -g @lrzdeveloper/probekit@latest` yourself, or use `npx @lrzdeveloper/probekit@latest`.')); }
  } catch { try { rl.close(); } catch {} }
}

async function main() {
  const raw = process.argv[2] || 'init';
  if (raw === '--version' || raw === '-v') { console.log(VERSION); return; }
  const cmd = (raw === '--help' || raw === '-h') ? 'help' : raw;
  const table = { init, setup: init, install: () => install({}), doctor, 'setup-engines': setupEngines, engines: setupEngines, uninstall, help };
  await (table[cmd] || help)();
  if (cmd !== 'help') await notifyUpdate();
}

main();

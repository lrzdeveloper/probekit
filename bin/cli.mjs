#!/usr/bin/env node
// probekit installer.
// Wires the REA MCP server + the probekit skill into Claude Code and
// Pi agent, and reports which analysis engines are present. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as readline from 'node:readline/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SKILL_SRC = path.join(PKG_ROOT, 'skills', 'probekit');
const REA_TOOLS = path.join(HOME, '.rea-tools');
const CLAUDE_CFG = path.join(HOME, '.claude.json');
const PI_CFG = path.join(HOME, '.pi', 'agent', 'mcp.json');
const REA_VERSION = 'rea-agents@6.8.0';
const REA_NODE_REQ = '^22.23.4 || ^24.22.1 || >=26.12.1'; // rea-agents@6.8.0 engines.node
const GHIDRA_SERIES = /^ghidra_12\.1\.\d+_PUBLIC$/; // REA requires the 12.1.x series

// Does the running Node satisfy what the pinned REA needs? (Node spawns the MCP.)
function nodeSatisfiesRea() {
  const [maj, min, pat] = process.versions.node.split('.').map(Number);
  const ge = (a, b, c) => maj > a || (maj === a && (min > b || (min === b && pat >= c)));
  if (maj === 22) return ge(22, 23, 4);
  if (maj === 24) return ge(24, 22, 1);
  if (maj >= 26) return ge(26, 12, 1);
  return false; // 23 and 25 are unsupported
}

const c = { dim: s => `\x1b[2m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m` };
const tilde = p => (p || '').replace(HOME, '~');

// ---- small shell + fs helpers ----
const sh = cmd => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
const which = bin => sh(`command -v ${bin}`);
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); };
const backup = p => { if (!exists(p)) return null; const b = `${p}.bak.${Date.now()}`; fs.copyFileSync(p, b); return b; };
const globFirst = (dir, re) => { try { return fs.readdirSync(dir).filter(f => re.test(f)).sort().reverse().map(f => path.join(dir, f))[0] || ''; } catch { return ''; } };

// ---- engine discovery (portable, not hardcoded to one machine) ----
function findJava() {
  const jh = sh('/usr/libexec/java_home 2>/dev/null');      // macOS
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

// REA MCP env, built from whatever is actually installed on this host.
function buildEnv(memOverride) {
  const env = {};
  const jar = findJadxJar(); if (jar) env.REA_JADX_MCP_JAR = jar;
  const java = findJava(); if (java) env.JAVA_HOME = java;
  const apk = which('apktool'); if (apk) env.REA_APKTOOL_COMMAND = apk;
  const gh = findGhidra();
  if (gh) { env.GHIDRA_INSTALL_DIR = gh; env.GHIDRA_MAXMEM = memOverride || `${ghidraMemG()}G`; env.REA_GHIDRA_STARTUP_TIMEOUT_MS = '1800000'; }
  return env;
}

// ---- actions ----
function registerRea(configPath, withType, memOverride) {
  const b = backup(configPath);
  const cfg = readJson(configPath);
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.rea = { ...(withType ? { type: 'stdio' } : {}), command: 'npx', args: ['-y', REA_VERSION, 'mcp'], env: buildEnv(memOverride) };
  writeJson(configPath, cfg);
  return b;
}

function installSkill() {
  const dst = path.join(HOME, '.claude', 'skills', 'probekit');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(SKILL_SRC, dst, { recursive: true });
  // Make it available to Pi agent too, as a symlink into its skills dir.
  const piSkills = path.join(HOME, '.pi', 'agent', 'skills');
  if (exists(path.join(HOME, '.pi', 'agent'))) {
    fs.mkdirSync(piSkills, { recursive: true });
    const link = path.join(piSkills, 'probekit');
    try { fs.rmSync(link, { force: true }); } catch {}
    try { fs.symlinkSync(dst, link); } catch {}
  }
  return dst;
}

function doctor() {
  const java = findJava(), gh = findGhidra(), jar = findJadxJar();
  const rows = [
    [`node (REA needs ${REA_NODE_REQ})`, nodeSatisfiesRea(), nodeSatisfiesRea() ? process.versions.node : `${process.versions.node} — update Node so the REA MCP can run`],
    ['java (JDK 17+)', !!java, java || 'brew install openjdk'],
    ['Ghidra 12.1.x', !!gh, gh || 'npx probekit setup-engines   (12.2+ is rejected by REA)'],
    ['jadx MCP jar', !!jar, jar || `place jadx-headless-mcp-*-all.jar in ${tilde(REA_TOOLS)} (ships with REA engine setup)`],
    ['apktool', !!which('apktool'), which('apktool') || 'brew install apktool'],
    ['mitmproxy', !!which('mitmdump'), which('mitmdump') || 'brew install mitmproxy'],
  ];
  console.log(c.b('\nEngine check\n'));
  for (const [name, ok, hint] of rows)
    console.log(`  ${ok ? c.g('✓') : c.r('✗')} ${name.padEnd(18)} ${ok ? c.dim(hint) : c.y(hint)}`);
  const reaClaude = !!(readJson(CLAUDE_CFG).mcpServers || {}).rea;
  const reaPi = exists(PI_CFG) && !!(readJson(PI_CFG).mcpServers || {}).rea;
  console.log(c.b('\nMCP wiring\n'));
  console.log(`  ${reaClaude ? c.g('✓') : c.r('✗')} REA registered in ~/.claude.json`);
  console.log(`  ${reaPi ? c.g('✓') : (exists(PI_CFG) ? c.r('✗') : c.dim('–'))} REA registered in ~/.pi/agent/mcp.json ${exists(PI_CFG) ? '' : c.dim('(Pi not installed)')}`);
  const skill = exists(path.join(HOME, '.claude', 'skills', 'probekit', 'SKILL.md'));
  console.log(`  ${skill ? c.g('✓') : c.r('✗')} probekit skill installed\n`);
}

// Non-interactive apply. opts: { claude, pi, mem }
function install(opts = {}) {
  const claude = opts.claude !== false;
  const pi = opts.pi !== undefined ? opts.pi : (exists(PI_CFG) || exists(path.join(HOME, '.pi', 'agent')));
  const mem = opts.mem;
  console.log(c.b('\nprobekit — install\n'));
  const skill = installSkill();
  console.log(`  ${c.g('✓')} skill → ${tilde(skill)}`);
  if (claude) { const b = registerRea(CLAUDE_CFG, false, mem); console.log(`  ${c.g('✓')} REA MCP → ~/.claude.json ${b ? c.dim(`(backup ${path.basename(b)})`) : ''}`); }
  if (pi) { const b = registerRea(PI_CFG, true, mem); console.log(`  ${c.g('✓')} REA MCP → ~/.pi/agent/mcp.json ${b ? c.dim(`(backup ${path.basename(b)})`) : ''}`); }
  const env = buildEnv(mem);
  if (!env.GHIDRA_INSTALL_DIR || !env.REA_JADX_MCP_JAR)
    console.log(c.y('\n  Some engines are missing — run `npx probekit doctor` then `npx probekit setup-engines`.'));
  console.log(c.dim('\n  Restart Claude Code / Pi (or reconnect the REA MCP) to pick up the changes.\n'));
  doctor();
}

// Guided, interactive setup. Falls back to a plain install when not a TTY.
async function init() {
  if (!process.stdin.isTTY) { console.log(c.dim('(non-interactive input — running install with discovered defaults)')); return install({}); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => { const a = (await rl.question(`${q}${def !== undefined ? c.dim(` [${def}]`) : ''}: `)).trim(); return a || (def !== undefined ? String(def) : ''); };
  const confirm = async (q, dy = true) => { const a = (await rl.question(`${q} ${c.dim(dy ? '(Y/n)' : '(y/N)')}: `)).trim().toLowerCase(); return a ? a.startsWith('y') : dy; };
  try {
    console.log(c.b('\nprobekit — guided setup'));
    console.log(c.dim('Detects your engines and agents, asks a few questions, shows what it will change, then applies.'));
    doctor();

    const hasClaude = exists(CLAUDE_CFG) || exists(path.join(HOME, '.claude'));
    const hasPi = exists(path.join(HOME, '.pi', 'agent'));
    const doClaude = hasClaude ? await confirm('Configure Claude Code (~/.claude.json)?', true) : false;
    if (!hasClaude) console.log(c.dim('  Claude Code not detected — skipping.'));
    const doPi = hasPi ? await confirm('Configure Pi agent (~/.pi/agent)?', true) : false;
    if (!hasPi) console.log(c.dim('  Pi agent not detected — skipping.'));
    if (!doClaude && !doPi) { console.log(c.y('\nNothing selected — nothing to do.')); return; }

    const ram = totalMemGB();
    let mem = await ask(`Ghidra heap size${ram ? ` (detected ~${ram.toFixed(0)}GB RAM)` : ''}`, `${ghidraMemG()}G`);
    if (!/g$/i.test(mem)) mem = (mem.replace(/[^0-9]/g, '') || ghidraMemG()) + 'G';

    const missing = [!findGhidra() && 'Ghidra 12.1.x', !findJadxJar() && 'jadx MCP jar', !which('apktool') && 'apktool', !which('mitmdump') && 'mitmproxy'].filter(Boolean);
    let runEngines = false;
    if (missing.length) { console.log(c.y(`\nMissing engines: ${missing.join(', ')}`)); runEngines = await confirm('Install the installable ones now (brew + guided Ghidra)?', false); }

    console.log(c.b('\nWill apply:'));
    console.log(`  • skill → ~/.claude/skills/probekit${doPi ? ' (+ Pi symlink)' : ''}`);
    if (doClaude) console.log(`  • REA MCP → ~/.claude.json   (Ghidra heap ${mem})`);
    if (doPi) console.log(`  • REA MCP → ~/.pi/agent/mcp.json   (Ghidra heap ${mem})`);
    if (runEngines) console.log('  • run setup-engines first');
    console.log(c.dim('  (every config file is backed up before writing)'));
    if (!await confirm('\nProceed?', true)) { console.log(c.y('Aborted — nothing was changed.')); return; }

    rl.close();
    if (runEngines) setupEngines();
    install({ claude: doClaude, pi: doPi, mem });
    return;
  } catch (e) {
    // Ctrl+D / closed stdin during a prompt — nothing has been written yet.
    if (e && e.code === 'ABORT_ERR') { console.log(c.y('\nAborted — nothing was changed.')); return; }
    throw e;
  } finally { try { rl.close(); } catch {} }
}

function setupEngines() {
  const brew = which('brew');
  console.log(c.b('\nsetup-engines\n'));
  if (brew) {
    for (const [f, probe] of [['openjdk', 'java'], ['apktool', 'apktool'], ['mitmproxy', 'mitmdump']]) {
      if (which(probe)) { console.log(`  ${c.g('✓')} ${f} already present`); continue; }
      console.log(c.dim(`  brew install ${f} ...`));
      try { execSync(`brew install ${f}`, { stdio: 'inherit' }); } catch { console.log(c.y(`  ! brew install ${f} failed — install it manually`)); }
    }
  } else {
    console.log(c.y('  Homebrew not found. Install openjdk, apktool and mitmproxy with your package manager.'));
  }
  if (findGhidra()) console.log(`  ${c.g('✓')} Ghidra 12.1.x already present`);
  else ghidraHelp();
  if (!findJadxJar()) console.log(c.y(`\n  jadx MCP jar not found. It is provisioned by REA's own engine setup; place\n  jadx-headless-mcp-*-all.jar in ${tilde(REA_TOOLS)} and re-run \`npx probekit install\`.`));
  console.log('');
}

function ghidraHelp() {
  console.log(c.y('\n  Ghidra 12.1.x not found. REA rejects 12.2+, so a brew install of the latest\n  will not work. Install the pinned release:'));
  console.log(c.dim(`    1. Download ghidra_12.1.x_PUBLIC from
       https://github.com/NationalSecurityAgency/ghidra/releases
    2. Unzip into ${tilde(REA_TOOLS)}/ (so you get ${tilde(REA_TOOLS)}/ghidra_12.1.x_PUBLIC/)
    3. If the decompiler native is missing for your CPU, build it once:
         <ghidra>/support/buildNatives
    4. Re-run \`npx probekit install\` to wire the path into the MCP env.`));
}

function uninstall() {
  console.log(c.b('\nuninstall (config only — engines are left in place)\n'));
  for (const [p, label] of [[CLAUDE_CFG, '~/.claude.json'], [PI_CFG, '~/.pi/agent/mcp.json']]) {
    if (!exists(p)) continue;
    const cfg = readJson(p);
    if (cfg.mcpServers && cfg.mcpServers.rea) { backup(p); delete cfg.mcpServers.rea; writeJson(p, cfg); console.log(`  ${c.g('✓')} removed REA MCP from ${label}`); }
  }
  for (const link of [path.join(HOME, '.pi', 'agent', 'skills', 'probekit')]) {
    try { if (fs.lstatSync(link).isSymbolicLink()) { fs.rmSync(link, { force: true }); console.log(`  ${c.g('✓')} removed Pi skill link`); } } catch {}
  }
  console.log(c.dim('  The ~/.claude/skills/probekit directory was left in place; delete it manually if you want it gone.\n'));
}

function help() {
  console.log(`
${c.b('probekit')} v${VERSION} — app-security / reverse-engineering stack installer

  ${c.b('npx probekit')} [command]

  (no command)   Guided interactive setup (same as 'init')
  init           Guided interactive setup: detect, ask, confirm, apply
  install        Non-interactive install with discovered defaults
  doctor         Report which engines and MCP wiring are present
  setup-engines  Install the analysis engines (brew where possible; Ghidra guided)
  uninstall      Remove the REA MCP entries and the Pi skill link
  help           This message
`);
}

const VERSION = (() => { try { return readJson(path.join(PKG_ROOT, 'package.json')).version || '0.0.0'; } catch { return '0.0.0'; } })();

// ---- update check (update-notifier style: daily-cached, fail-silent, off in CI) ----
const semverGt = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; } return false; };
async function latestVersion() {
  const cacheFile = path.join(os.tmpdir(), 'probekit-update-check.json');
  try { const c = readJson(cacheFile); if (c.at && Date.now() - c.at < 864e5 && c.v) return c.v; } catch {}
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch('https://registry.npmjs.org/probekit/latest', { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const v = (await r.json()).version;
    try { writeJson(cacheFile, { at: Date.now(), v }); } catch {}
    return v;
  } catch { return null; }
}
async function notifyUpdate() {
  if (!process.stdout.isTTY || process.env.CI || process.env.PROBEKIT_NO_UPDATE_CHECK) return;
  try { const l = await latestVersion(); if (l && semverGt(l, VERSION)) console.log(c.y(`\n  ▲ probekit ${l} is available (you have ${VERSION}) — run \`npx probekit@latest\``)); } catch {}
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

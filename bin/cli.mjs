#!/usr/bin/env node
// probekit installer.
// Registers the REA MCP server (and, where supported, the probekit skill) into
// whichever AI agents you have — detected dynamically, chosen by you. Zero deps.
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
const REA_VERSION = 'rea-agents@6.8.0';
const REA_NODE_REQ = '^22.23.4 || ^24.22.1 || >=26.12.1'; // rea-agents@6.8.0 engines.node
const GHIDRA_SERIES = /^ghidra_12\.1\.\d+_PUBLIC$/;        // REA requires the 12.1.x series

const c = { dim: s => `\x1b[2m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m` };
const tilde = p => (p || '').replace(HOME, '~');

// ---- tiny zero-dep TUI (clack/Pi-installer style): clear, banner, spinner ----
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clear = () => process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
async function spin(label, ms = 420) {
  let i = 0;
  const t = setInterval(() => process.stdout.write(`\r  ${c.y(SPIN[i++ % SPIN.length])} ${label}\x1b[K`), 80);
  await sleep(ms);
  clearInterval(t);
  process.stdout.write(`\r  ${c.g('◇')} ${label}\x1b[K\n`);
}
function banner() {
  console.log(`\n  ${c.b(c.g('◆ probekit'))} ${c.dim('v' + VERSION)}`);
  console.log(`  ${c.dim('app-security / reverse-engineering stack installer')}\n`);
}
function engineLine() {
  const items = [['Ghidra', !!findGhidra()], ['jadx', !!findJadxJar()], ['apktool', !!which('apktool')], ['mitmproxy', !!which('mitmdump')], ['node', nodeSatisfiesRea()]];
  return '  ' + items.map(([n, ok]) => (ok ? c.g('✓ ' + n) : c.r('✗ ' + n))).join(c.dim('  ·  '));
}

// ---- small shell + fs helpers ----
const sh = cmd => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
const which = bin => sh(`command -v ${bin}`);
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); };
const backup = p => { if (!exists(p)) return null; const b = `${p}.bak.${Date.now()}`; fs.copyFileSync(p, b); return b; };
const globFirst = (dir, re) => { try { return fs.readdirSync(dir).filter(f => re.test(f)).sort().reverse().map(f => path.join(dir, f))[0] || ''; } catch { return ''; } };

// ---- agent targets: detected dynamically, chosen by the user ----
// mcp.type:'stdio' only where the agent's schema expects it (Pi). skillDir set
// only for agents that understand SKILL.md (Claude Code, Pi); others get the
// REA MCP alone.
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
    mcpFile: path.join(HOME, '.cursor', 'mcp.json') },
  { id: 'windsurf', label: 'Windsurf',
    detect: () => exists(path.join(HOME, '.codeium', 'windsurf')),
    mcpFile: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json') },
  { id: 'claude-desktop', label: 'Claude Desktop',
    detect: () => exists(path.join(HOME, 'Library', 'Application Support', 'Claude')) || exists(path.join(HOME, '.config', 'Claude')),
    mcpFile: process.platform === 'darwin'
      ? path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json') },
];
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
function reaEntry(agent, mem) { return { ...(agent.mcpType ? { type: agent.mcpType } : {}), command: 'npx', args: ['-y', REA_VERSION, 'mcp'], env: buildEnv(mem) }; }
function registerReaIn(agent, mem) {
  const b = backup(agent.mcpFile);
  const cfg = readJson(agent.mcpFile);
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.rea = reaEntry(agent, mem);
  writeJson(agent.mcpFile, cfg);
  return b;
}
function installSkillInto(agent) {
  if (!agent.skillDir) return null;
  fs.rmSync(agent.skillDir, { recursive: true, force: true });
  fs.cpSync(SKILL_SRC, agent.skillDir, { recursive: true });
  return agent.skillDir;
}
const reaInstalled = agent => exists(agent.mcpFile) && !!(readJson(agent.mcpFile).mcpServers || {}).rea;
const skillInstalled = agent => !!agent.skillDir && exists(path.join(agent.skillDir, 'SKILL.md'));
// Agents only load/unload probekit on restart — always tell the user to reload.
const reloadNote = (labels, appearing) => c.dim(`\n  Restart / reconnect ${labels.length ? labels.join(', ') : 'your agent(s)'} ${appearing ? 'so probekit (its skill + REA tools) shows up.' : 'so probekit is fully unloaded.'}\n`);

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
  console.log(c.b('\nMCP wiring\n'));
  for (const a of AGENTS) {
    const det = a.detect();
    const bits = [reaInstalled(a) ? c.g('REA ✓') : det ? c.r('REA ✗') : c.dim('REA –')];
    if (a.skillDir) bits.push(skillInstalled(a) ? c.g('skill ✓') : det ? c.r('skill ✗') : c.dim('skill –'));
    else bits.push(c.dim('(MCP only)'));
    console.log(`  ${det ? c.g('●') : c.dim('○')} ${a.label.padEnd(15)} ${bits.join('   ')}${det ? '' : c.dim('  not detected')}`);
  }
  console.log('');
}

// Non-interactive apply. opts: { agents: [ids]|undefined (default detected), mem }
function install(opts = {}) {
  const agents = (opts.agents ? opts.agents.map(byId).filter(Boolean) : detected());
  const mem = opts.mem;
  console.log(c.b('\nprobekit — install\n'));
  if (!agents.length) { console.log(c.y('  No agents selected or detected — nothing to do.\n')); return; }
  for (const a of agents) {
    const b = registerReaIn(a, mem);
    console.log(`  ${c.g('✓')} REA MCP → ${tilde(a.mcpFile)} ${b ? c.dim(`(backup ${path.basename(b)})`) : ''}`);
    if (a.skillDir) { installSkillInto(a); console.log(`  ${c.g('✓')} skill  → ${tilde(a.skillDir)}`); }
  }
  if (!nodeSatisfiesRea()) console.log(c.y(`\n  ⚠ Node ${process.versions.node} is too old for REA (${REA_NODE_REQ}).\n    Update Node, then reconnect the MCP. Until then REA will report unhealthy.`));
  const env = buildEnv(mem);
  if (!env.GHIDRA_INSTALL_DIR || !env.REA_JADX_MCP_JAR) console.log(c.y('\n  Some engines are missing — run `probekit setup-engines`.'));
  console.log(reloadNote(agents.map(a => a.label), true));
  doctor();
}

// Guided, interactive setup — clack/Pi-installer style: clears between steps,
// keeps a running summary, animates the apply. Falls back to a plain install
// when not a TTY (piped, CI). Enter always accepts the shown default.
async function init() {
  if (!process.stdin.isTTY) { console.log(c.dim('(non-interactive input — running install for detected agents)')); return install({}); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answered = [];
  const frame = () => {
    clear(); banner();
    console.log(engineLine() + '\n');
    for (const s of answered) console.log(`  ${c.g('◇')} ${c.dim(s.l + ':')} ${s.v}`);
    if (answered.length) console.log();
  };
  const ask = async (q, def) => { frame(); const a = (await rl.question(`  ${c.b(c.g('?'))} ${q}${def !== undefined ? c.dim(` [${def}]`) : ''} `)).trim(); return a || (def !== undefined ? String(def) : ''); };
  const confirm = async (q, dy = true) => { frame(); const a = (await rl.question(`  ${c.b(c.g('?'))} ${q} ${c.dim(dy ? '(Y/n)' : '(y/N)')} `)).trim().toLowerCase(); return a ? a.startsWith('y') : dy; };
  try {
    clear(); banner();
    console.log(c.dim('  Press Enter to accept each default (the capitalised Y or N).'));
    await spin('Scanning engines and agents…', 650);

    const chosen = [];
    for (const a of AGENTS) {
      const det = a.detect();
      const tag = det ? c.g('(detected)') : c.dim('(not detected)');
      const extra = a.skillDir ? '' : c.dim(' · REA MCP only');
      const ok = await confirm(`${a.label} ${tag}${extra}`, det);
      answered.push({ l: a.label, v: ok ? c.g('yes') : c.dim('no') });
      if (ok) chosen.push(a);
    }
    if (!chosen.length) { frame(); console.log(c.y('  Nothing selected — nothing to do.\n')); return; }

    let mem = await ask('Ghidra heap size', `${ghidraMemG()}G`);
    if (!/g$/i.test(mem)) mem = (mem.replace(/[^0-9]/g, '') || ghidraMemG()) + 'G';
    answered.push({ l: 'Ghidra heap', v: mem });

    const missing = [!findGhidra() && 'Ghidra 12.1.x', !findJadxJar() && 'jadx MCP jar', !which('apktool') && 'apktool', !which('mitmdump') && 'mitmproxy'].filter(Boolean);
    let runEngines = false;
    if (missing.length) { runEngines = await confirm(`Install missing engines now (${missing.join(', ')})?`, false); answered.push({ l: 'Install engines', v: runEngines ? c.g('yes') : c.dim('no') }); }

    // Offer a Node upgrade only when it's too old AND brew-managed (safe to upgrade).
    let upgradeNode = false;
    if (!nodeSatisfiesRea() && nodeViaBrew()) {
      upgradeNode = await confirm(`Node ${process.versions.node} is too old for REA — run \`brew upgrade node\` now? ${c.dim('(system-wide, affects all your Node projects)')}`, false);
      answered.push({ l: 'Upgrade Node', v: upgradeNode ? c.g('yes') : c.dim('no') });
    }

    // summary screen (no frame() so it stays put while we confirm)
    clear(); banner();
    console.log(engineLine() + '\n');
    console.log(c.b('  Will apply:'));
    for (const a of chosen) console.log(`    • ${a.label} → REA MCP${a.skillDir ? c.g(' + skill') : ''}  ${c.dim(`(Ghidra heap ${mem})`)}`);
    if (runEngines) console.log('    • install missing engines first');
    if (upgradeNode) console.log('    • ' + c.y('brew upgrade node') + c.dim(' (system-wide) first'));
    console.log(c.dim('    every config file is backed up before writing'));
    if (!nodeSatisfiesRea() && !upgradeNode) console.log(c.y(`\n  ⚠ Node ${process.versions.node} is below REA's requirement (${REA_NODE_REQ})${nodeViaBrew() ? '' : ' — upgrade it via your Node manager'}.`));
    const ans = (await rl.question(`\n  ${c.b(c.g('?'))} Proceed? ${c.dim('(Y/n)')} `)).trim().toLowerCase();
    if (ans && !ans.startsWith('y')) { console.log(c.y('\n  Aborted — nothing was changed.\n')); return; }
    rl.close();

    if (runEngines) setupEngines();
    if (upgradeNode) {
      clear(); banner();
      console.log(c.b('  Upgrading Node via Homebrew…') + c.dim('  (one-time, system-wide; brew output follows)\n'));
      try { execSync('brew upgrade node', { stdio: 'inherit' }); } catch { console.log(c.y('\n  brew upgrade node failed — upgrade Node manually.')); }
    }
    clear(); banner();
    for (const a of chosen) {
      await spin(`Configuring ${a.label}…`, 260);
      registerReaIn(a, mem);
      if (a.skillDir) installSkillInto(a);
    }
    console.log(`\n  ${c.g('✓')} ${c.b('probekit installed')} for ${chosen.map(a => a.label).join(', ')}.`);
    const nv = (sh('node -v') || '').replace(/^v/, '');
    if (upgradeNode && nodeSatisfiesReaV(nv)) console.log(c.g(`\n  ✓ Node is now ${nv} — satisfies REA.`));
    else if (!nodeSatisfiesRea()) console.log(c.y(`\n  ⚠ Update Node (${REA_NODE_REQ})${nodeViaBrew() ? ' — `brew upgrade node`' : ' via your Node manager'} — then reconnect; REA stays unhealthy until then.`));
    console.log(reloadNote(chosen.map(a => a.label), true));
    return;
  } catch (e) {
    // stdin closed mid-flow (Ctrl+D, piped EOF) — nothing was written yet.
    if (e && (e.code === 'ABORT_ERR' || e.code === 'ERR_USE_AFTER_CLOSE')) { console.log(c.y('\n  Aborted — nothing was changed.\n')); return; }
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
  console.log(c.b('\nuninstall (config only — engines are left in place)\n'));
  const touched = [];
  for (const a of AGENTS) {
    let hit = false;
    if (reaInstalled(a)) { const cfg = readJson(a.mcpFile); backup(a.mcpFile); delete cfg.mcpServers.rea; writeJson(a.mcpFile, cfg); console.log(`  ${c.g('✓')} removed REA MCP from ${tilde(a.mcpFile)}`); hit = true; }
    if (skillInstalled(a)) { fs.rmSync(a.skillDir, { recursive: true, force: true }); console.log(`  ${c.g('✓')} removed skill from ${tilde(a.skillDir)}`); hit = true; }
    if (hit) touched.push(a.label);
  }
  if (!touched.length) { console.log(c.dim('  Nothing to remove — probekit was not wired into any agent.\n')); return; }
  console.log(reloadNote(touched, false));
}

function help() {
  console.log(`
${c.b('probekit')} v${VERSION} — app-security / reverse-engineering stack installer

  ${c.b('npx probekit')} [command]

  (no command)   Guided interactive setup (same as 'init')
  init           Guided interactive setup: detect agents, choose, confirm, apply
  install        Non-interactive install for all detected agents
  doctor         Report engines and, per agent, REA + skill wiring
  setup-engines  Install the analysis engines (brew where possible; Ghidra guided)
  uninstall      Remove the REA MCP entries and the probekit skill from all agents
  help           This message

  Supported agents: ${AGENTS.map(a => a.label).join(', ')}
`);
}

const VERSION = (() => { try { return readJson(path.join(PKG_ROOT, 'package.json')).version || '0.0.0'; } catch { return '0.0.0'; } })();

// ---- update check: daily-cached, fail-silent, off in CI; offers to apply ----
const semverGt = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; } return false; };
async function latestVersion() {
  const cacheFile = path.join(os.tmpdir(), 'probekit-update-check.json');
  try { const cc = readJson(cacheFile); if (cc.at && Date.now() - cc.at < 864e5 && cc.v) return cc.v; } catch {}
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
  const l = await latestVersion();
  if (!l || !semverGt(l, VERSION)) return;
  console.log(c.y(`\n  ▲ probekit ${l} is available (you have ${VERSION}).`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`  Update now? ${c.dim('(y/N)')}: `)).trim().toLowerCase();
    rl.close();
    if (!a.startsWith('y')) { console.log(c.dim('  Later: `npm i -g probekit@latest`, or just run `npx probekit@latest`.')); return; }
    console.log(c.dim('  Updating globally via npm…'));
    try { execSync('npm install -g probekit@latest', { stdio: 'inherit' }); console.log(c.g('  Updated — re-run `probekit` to use the new version.')); }
    catch { console.log(c.y('  Update failed — run `npm i -g probekit@latest` manually (or use `npx probekit@latest`).')); }
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

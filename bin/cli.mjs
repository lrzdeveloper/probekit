#!/usr/bin/env node
// probekit installer.
// Registers the REA MCP server (and, where supported, the probekit skill) into
// whichever AI agents you have — detected dynamically, chosen by you. Zero deps.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as readline from 'node:readline/promises';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { parse as jsoncParse, modify as jsoncModify, applyEdits } from 'jsonc-parser';

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
// spinners keep animating). Returns true on exit code 0.
const run = (cmd, args, ms = 90000) => new Promise(resolve => {
  let child;
  try { child = spawn(cmd, args, { stdio: 'ignore' }); }
  catch { return resolve(false); }
  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(false); }, ms);
  child.on('error', () => { clearTimeout(t); resolve(false); });
  child.on('exit', code => { clearTimeout(t); resolve(code === 0); });
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
const sh = cmd => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
const which = bin => sh(`command -v ${bin}`);
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); };
const backup = p => { if (!exists(p)) return null; const b = `${p}.bak.${Date.now()}`; fs.copyFileSync(p, b); return b; };
const globFirst = (dir, re) => { try { return fs.readdirSync(dir).filter(f => re.test(f)).sort().reverse().map(f => path.join(dir, f))[0] || ''; } catch { return ''; } };

// ---- agent targets: detected dynamically, chosen by the user ----
// Every selected agent ALWAYS gets the REA MCP (the skill is useless without it).
// The skill is delivered either natively (skillDir, for agents that read
// SKILL.md: Claude Code, Pi) or via the `skills` CLI (skillsAgent). Claude
// Desktop is MCP-only — it has no skill mechanism.
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
  // Different MCP config shapes — one verified adapter each (see installMcp).
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

// Where `npx skills add -g` drops the skill per agent (from the skills docs) —
// used to verify/remove it directly without the CLI.
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
// docs). Codex is TOML, so we let its own CLI edit the file.
const mcpKeyFor = fmt => fmt === 'amp' ? 'amp.mcpServers' : fmt === 'zed' ? 'context_servers' : fmt === 'opencode' ? 'mcp' : 'mcpServers';
async function installMcp(agent, mem) {
  const env = buildEnv(mem);
  const args = ['-y', REA_VERSION, 'mcp'];
  const fmt = agent.format || 'mcpServers';
  if (fmt === 'codex') {
    // The `codex` CLI is often a shim (e.g. cmux) that no-ops outside its own
    // terminal, so we edit config.toml directly. Idempotent: skip if present.
    if (reaInstalled(agent)) return { ok: true, note: 'already configured' };
    const b = backup(agent.mcpFile);
    const q = s => JSON.stringify(String(s)); // TOML basic string (JSON-compatible escaping)
    let block = `\n[mcp_servers.rea]\ncommand = "npx"\nargs = [ ${args.map(q).join(', ')} ]\nstartup_timeout_sec = 60\n`;
    const envEntries = Object.entries(env);
    if (envEntries.length) block += `\n[mcp_servers.rea.env]\n${envEntries.map(([k, v]) => `${k} = ${q(v)}`).join('\n')}\n`;
    fs.mkdirSync(path.dirname(agent.mcpFile), { recursive: true });
    const existing = exists(agent.mcpFile) ? fs.readFileSync(agent.mcpFile, 'utf8') : '';
    fs.writeFileSync(agent.mcpFile, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + block);
    return { ok: true, backup: b };
  }
  // JSON / JSONC: edit surgically (jsonc-parser) so comments AND formatting
  // survive — works on Zed/Amp/VS Code even with comments, and only touches the
  // `rea` key in big files like ~/.claude.json.
  const key = mcpKeyFor(fmt);
  const value = fmt === 'opencode' ? { type: 'local', command: ['npx', ...args], environment: env, enabled: true }
    : fmt === 'zed' ? { source: 'custom', command: 'npx', args, env }
    : { ...(agent.mcpType ? { type: agent.mcpType } : {}), command: 'npx', args, env }; // mcpServers + amp
  const text = exists(agent.mcpFile) ? fs.readFileSync(agent.mcpFile, 'utf8') : '';
  const next = jsoncEdit(text, [key, 'rea'], value);
  if (next === null) return { ok: false, hint: `add it by hand to ${tilde(agent.mcpFile)} — the file has JSON syntax errors` };
  const b = backup(agent.mcpFile);
  fs.mkdirSync(path.dirname(agent.mcpFile), { recursive: true });
  fs.writeFileSync(agent.mcpFile, next);
  return { ok: true, backup: b };
}
function removeMcp(agent) {
  const fmt = agent.format || 'mcpServers';
  if (fmt === 'codex') {
    if (!exists(agent.mcpFile)) return false;
    const raw = fs.readFileSync(agent.mcpFile, 'utf8');
    if (!raw.includes('[mcp_servers.rea]')) return false;
    backup(agent.mcpFile);
    const out = []; let skip = false;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t === '[mcp_servers.rea]' || t.startsWith('[mcp_servers.rea.')) { skip = true; continue; }
      if (skip && t.startsWith('[') && !t.startsWith('[mcp_servers.rea')) skip = false;
      if (!skip) out.push(line);
    }
    fs.writeFileSync(agent.mcpFile, out.join('\n'));
    return true;
  }
  if (!exists(agent.mcpFile)) return false;
  const text = fs.readFileSync(agent.mcpFile, 'utf8'), key = mcpKeyFor(fmt);
  const obj = jsoncParse(text) || {};
  if (!(obj[key] && obj[key].rea)) return false;
  const next = jsoncEdit(text, [key, 'rea'], undefined);
  if (next === null) return false;
  backup(agent.mcpFile);
  fs.writeFileSync(agent.mcpFile, next);
  return true;
}
function installSkillInto(agent) {
  if (!agent.skillDir) return null;
  fs.rmSync(agent.skillDir, { recursive: true, force: true });
  fs.cpSync(SKILL_SRC, agent.skillDir, { recursive: true });
  return agent.skillDir;
}
// Deliver the skill: natively (SKILL.md copy) for Claude Code/Pi, or via the
// vercel-labs `skills` CLI for the rest. Returns {how} or null (MCP-only agent).
async function installSkillFor(agent) {
  if (agent.skillDir) { installSkillInto(agent); return { how: 'native', where: agent.skillDir }; }
  if (agent.skillsAgent) {
    const ok = await run('npx', ['-y', 'skills@latest', 'add', SKILLS_REPO, '--skill', 'probekit', '-a', agent.skillsAgent, '-g', '-y']);
    return { how: ok ? 'skills-cli' : 'skills-cli-failed' };
  }
  return null; // no skill mechanism
}
function reaInstalled(agent) {
  const fmt = agent.format || 'mcpServers';
  if (fmt === 'codex') { try { return fs.readFileSync(agent.mcpFile, 'utf8').includes('[mcp_servers.rea]'); } catch { return false; } }
  if (!exists(agent.mcpFile)) return false;
  const obj = jsoncParse(fs.readFileSync(agent.mcpFile, 'utf8')) || {};
  return !!(obj[mcpKeyFor(fmt)] || {}).rea;
}
const skillDirOf = agent => (agent.skillDir && exists(path.join(agent.skillDir, 'SKILL.md'))) ? agent.skillDir
  : (agent.skillGlobalDir && exists(path.join(agent.skillGlobalDir, 'SKILL.md'))) ? agent.skillGlobalDir : null;
const skillInstalled = agent => !!skillDirOf(agent);
// Agents only load/unload probekit on restart — always tell the user to reload.
const reloadNote = (labels, appearing) => c.dim(`\n  Restart / reconnect ${labels.length ? labels.join(', ') : 'your agent(s)'} ${appearing ? 'so probekit (its skill + REA tools) shows up.' : 'so probekit is fully unloaded.'}\n`);

function doctor() {
  const java = findJava(), gh = findGhidra(), jar = findJadxJar();
  const rows = [
    [`node (REA needs ${REA_NODE_REQ})`, nodeSatisfiesRea(), nodeSatisfiesRea() ? process.versions.node : `${process.versions.node} — update Node so the REA MCP can run`],
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
    const bits = [reaInstalled(a) ? c.g('REA ✓') : det ? c.r('REA ✗') : c.dim('REA –')];
    if (a.skillDir || a.skillGlobalDir) bits.push(skillInstalled(a) ? c.g('skill ✓') : det ? c.r('skill ✗') : c.dim('skill –'));
    else bits.push(c.dim('(MCP only)'));
    console.log(`  ${det ? c.g('●') : c.dim('○')} ${a.label.padEnd(15)} ${bits.join('   ')}${det ? '' : c.dim('  not detected')}`);
  }
  console.log('');
}

// Non-interactive apply. opts: { agents: [ids]|undefined (default detected), mem }
async function install(opts = {}) {
  const agents = (opts.agents ? opts.agents.map(byId).filter(Boolean) : detected());
  const mem = opts.mem;
  console.log(c.b('\nprobekit — install\n'));
  if (!agents.length) { console.log(c.y('  No agents selected or detected — nothing to do.\n')); return; }
  for (const a of agents) {
    const m = await installMcp(a, mem);
    if (m.ok) console.log(`  ${c.g('✓')} REA MCP → ${tilde(a.mcpFile)} ${m.note ? c.dim(`(${m.note})`) : m.backup ? c.dim(`(backup ${path.basename(m.backup)})`) : ''}`);
    else console.log(c.y(`  ! REA MCP not set for ${a.label} — run: ${m.hint}`));
    const sk = await installSkillFor(a);
    if (sk?.how === 'native') console.log(`  ${c.g('✓')} skill  → ${tilde(sk.where)}`);
    else if (sk?.how === 'skills-cli') console.log(`  ${c.g('✓')} skill  → via skills CLI (${a.skillsAgent})`);
    else if (sk?.how === 'skills-cli-failed') console.log(c.y(`  ! skill not installed — run: npx skills add ${SKILLS_REPO} -a ${a.skillsAgent}`));
  }
  if (!nodeSatisfiesRea()) console.log(c.y(`\n  ⚠ Node ${process.versions.node} is too old for REA (${REA_NODE_REQ}).\n    Update Node, then reconnect the MCP. Until then REA will report unhealthy.`));
  const env = buildEnv(mem);
  if (!env.GHIDRA_INSTALL_DIR || !env.REA_JADX_MCP_JAR) console.log(c.y('\n  Some engines are missing — run `probekit setup-engines`.'));
  console.log(reloadNote(agents.map(a => a.label), true));
  doctor();
}

// Guided, interactive setup with @clack/prompts: a searchable multiselect over
// agents (type to filter, space to toggle), spinners for the apply. Every
// selected agent ALWAYS gets the REA MCP (+ the skill). Falls back to a plain
// install when not a TTY (piped, CI).
async function init() {
  if (!process.stdin.isTTY) { console.log(c.dim('(non-interactive — running install for detected agents)')); return install({}); }
  const bail = (m = 'Aborted — nothing was changed.') => { p.cancel(m); };
  try {
    p.intro(c.b(`probekit v${VERSION}`) + c.dim('  — app-security / reverse-engineering stack'));

    p.note([
      `${nodeSatisfiesRea() ? '✓' : '✗'} node ${process.versions.node}${nodeSatisfiesRea() ? '' : '  (too old for REA)'}`,
      `${findGhidra() ? '✓' : '✗'} Ghidra 12.1.x`,
      `${findJadxJar() ? '✓' : '✗'} jadx`,
      `${which('apktool') ? '✓' : '✗'} apktool`,
      `${which('mitmdump') ? '✓' : '✗'} mitmproxy`,
    ].join('\n'), 'Engines');

    const sel = await p.autocompleteMultiselect({
      message: 'Which agents get probekit? (REA MCP + skill — type to search, space to toggle)',
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
      const r = await p.confirm({ message: `Node ${process.versions.node} is too old for REA — run \`brew upgrade node\` now? (system-wide)`, initialValue: false });
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

    if (runEngines) setupEngines();
    if (upgradeNode) {
      const s = p.spinner(); s.start('brew upgrade node (system-wide)');
      const ok = await run('brew', ['upgrade', 'node']);
      s.stop(ok ? 'Node upgraded' : 'brew upgrade node failed — upgrade Node manually');
    }
    const done = [], manual = [];
    for (const a of agents) {
      const was = reaInstalled(a);
      const s = p.spinner(); s.start(`${was ? 'Updating' : 'Configuring'} ${a.label}`);
      const [m, sk] = await Promise.all([installMcp(a, mem), installSkillFor(a), sleep(400)]);
      const mcpTag = m.ok ? (m.note ? `REA MCP (${m.note})` : 'REA MCP') : 'REA MCP — manual step needed';
      const skTag = sk?.how === 'native' ? ' + skill'
        : sk?.how === 'skills-cli' ? ' + skill (via skills CLI)'
        : sk?.how === 'skills-cli-failed' ? ' (skill failed — run `npx skills add` manually)'
        : '';
      s.stop(`${a.label} — ${mcpTag}${skTag}`);
      if (m.ok) done.push(a.label);
      else { manual.push({ label: a.label, hint: m.hint }); p.log.warn(`${a.label}: ${m.hint}`); }
    }

    const nv = (sh('node -v') || '').replace(/^v/, '');
    const nodeOkNow = upgradeNode ? nodeSatisfiesReaV(nv) : nodeSatisfiesRea();
    if (upgradeNode && nodeOkNow) p.log.success(`Node is now ${nv} — satisfies REA.`);

    const steps = [];
    if (done.length) steps.push(`Restart / reconnect ${done.join(', ')} so probekit loads.`);
    if (manual.length) steps.push(`Finish by hand for ${manual.map(x => x.label).join(', ')} (commands shown above).`);
    if (!nodeOkNow) steps.push(`Update Node to ${REA_NODE_REQ}${nodeViaBrew() ? ' — run \`brew upgrade node\`' : ' via your Node manager'}. REA stays unhealthy until then.`);
    if (steps.length) p.note(steps.map((s, i) => `${c.dim(`${i + 1}.`)} ${s}`).join('\n'), 'Next steps');
    p.note(`${c.b(`npx skills add ${SKILLS_REPO}`)}\n${c.dim('Installs the probekit skill on any of 80+ other coding agents.')}`, 'Add probekit elsewhere');
    p.outro(done.length
      ? c.g(`✓ REA MCP ready on ${done.join(', ')}`) + (manual.length ? c.y(`  ·  ${manual.length} need a manual step`) : '')
      : c.y('No agent fully configured — see the manual steps above.'));
    return;
  } catch (e) {
    if (e && (e.code === 'ABORT_ERR' || e.code === 'ERR_USE_AFTER_CLOSE')) return bail();
    throw e;
  }
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
    if (removeMcp(a)) { console.log(`  ${c.g('✓')} removed REA MCP from ${a.label}`); hit = true; }
    const skdir = skillDirOf(a); // native or skills-CLI global dir — removed directly (no npx, no hang)
    if (skdir) { fs.rmSync(skdir, { recursive: true, force: true }); console.log(`  ${c.g('✓')} removed skill from ${tilde(skdir)}`); hit = true; }
    if (hit) touched.push(a.label);
  }
  if (!touched.length) { console.log(c.dim('  Nothing to remove — probekit was not wired into any agent.\n')); return; }
  console.log(reloadNote(touched, false));
}

function help() {
  console.log(`
${c.b('probekit')} v${VERSION} — app-security / reverse-engineering stack installer

  ${c.b('probekit')} [command]   ${c.dim('(install: npx @lrzdeveloper/probekit)')}

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
    const r = await fetch('https://registry.npmjs.org/@lrzdeveloper%2Fprobekit/latest', { signal: ac.signal });
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
    if (!a.startsWith('y')) { console.log(c.dim('  Later: `npm i -g @lrzdeveloper/probekit@latest`, or just run `npx @lrzdeveloper/probekit@latest`.')); return; }
    console.log(c.dim('  Updating globally via npm…'));
    try { execSync('npm install -g @lrzdeveloper/probekit@latest', { stdio: 'inherit' }); console.log(c.g('  Updated — re-run `probekit` to use the new version.')); }
    catch { console.log(c.y('  Update failed — run `npm i -g @lrzdeveloper/probekit@latest` manually (or use `npx @lrzdeveloper/probekit@latest`).')); }
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

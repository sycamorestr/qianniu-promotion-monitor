#!/usr/bin/env node
import { access, lstat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOpencli, validateConfig } from '../runner.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterNames = ['scan-campaigns.js', 'pause-campaign.js', 'whoami.js'];
const help = `Usage: node scripts/check.mjs [--config FILE] [--opencli-dir DIR] [--mode report|dry-run|execute] [--json]

Read-only checks for Node.js, config, OpenCLI, adapter consistency, and Webhook
presence. OPENCLI_BIN may specify an executable or an exact executable path.
No command, browser, login check, notification, or campaign action is executed.
Webhook is optional in report mode (the default), required in other modes.`;

function parseArgs(args) {
  const options = { mode: 'report' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw new Error(`Duplicate option: ${key}`);
    seen.add(key);
    if (key === '--help' || key === '--json') { options[key.slice(2)] = true; continue; }
    if (!['--config', '--opencli-dir', '--mode'].includes(key)) throw new Error(`Unknown option: ${key}`);
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
    options[key.slice(2)] = args[++i];
  }
  if (!['report', 'dry-run', 'execute'].includes(options.mode)) throw new Error('--mode must be report, dry-run, or execute');
  return options;
}

const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

export async function resolveExecutable(command, env = process.env, platform = process.platform) {
  if (!command || !command.trim()) return null;
  const hasPath = /[\\/]/.test(command) || path.isAbsolute(command);
  const bases = hasPath ? [path.resolve(command)] : (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory.replace(/^"|"$/g, ''), command));
  const extensions = platform === 'win32' && !path.extname(command)
    ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';'), '.ps1'] : [''];
  for (const base of bases) {
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      try {
        const info = await lstat(candidate);
        if (!info.isFile() && !info.isSymbolicLink()) continue;
        await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* Try the next PATH candidate. */ }
    }
  }
  return null;
}

export async function checkEnvironment(options = {}, root = sourceRoot, env = process.env) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const mode = options.mode || 'report';
  const configPath = path.resolve(options.config || path.join(root, 'config.json'));
  const opencliDir = path.resolve(options['opencli-dir'] || path.join(os.homedir(), '.opencli', 'clis', 'alimama'));
  add('Node.js', Number(process.versions.node.split('.')[0]) >= 20, `v${process.versions.node}; requires >=20`);
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    try {
      validateConfig(config);
      add('Configuration', true, `${config.profiles.length} shop profile(s) validated`);
    } catch (error) { add('Configuration', false, error.message); }
  } catch (error) {
    // JSON parser errors may contain source text, so avoid echoing private config contents.
    add('Configuration', false, error instanceof SyntaxError ? 'Invalid JSON in config file' : `Cannot read config file (${error.code || 'read error'})`);
  }
  try {
    const launch = resolveOpencli(env);
    const binary = launch.prefix.length ? launch.prefix.at(-1) : launch.command;
    const executable = await resolveExecutable(binary, env);
    add('OpenCLI', Boolean(executable), executable ? 'Executable located' : 'OpenCLI exists but is not executable');
    if (process.platform === 'win32' && launch.prefix.length) {
      const pwsh = await resolveExecutable(launch.command, env);
      add('PowerShell 7', Boolean(pwsh), pwsh ? 'pwsh located for the .ps1 shim' : 'The OpenCLI .ps1 shim requires pwsh on PATH');
    }
  } catch (error) { add('OpenCLI', false, error.message); }
  for (const name of adapterNames) {
    try {
      const [source, installed] = await Promise.all([readFile(path.join(root, 'adapters', name)), readFile(path.join(opencliDir, name))]);
      add(`Adapter ${name}`, source.equals(installed), source.equals(installed) ? 'Installed adapter matches this package' : 'Installed adapter differs; rerun scripts/install.mjs');
    } catch (error) { add(`Adapter ${name}`, false, `Cannot read source or installed adapter (${error.code || 'read error'}); run scripts/install.mjs`); }
  }
  const webhookPresent = nonEmpty(env.WECHAT_WEBHOOK_URL);
  add('WECHAT_WEBHOOK_URL', webhookPresent || mode === 'report', webhookPresent ? 'Present (value hidden)' : mode === 'report' ? 'Absent; optional in report mode' : `Absent; required in ${mode} mode`);
  return { ok: checks.every(check => check.ok), mode, checks, note: 'Browser Bridge availability and shop login state require a separate authorized browser check.' };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  const result = await checkEnvironment(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const check of result.checks) console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`);
    console.log(result.note);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Check failed: ${error.message}`); process.exitCode = 1; });
}

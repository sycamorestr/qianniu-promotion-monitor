#!/usr/bin/env node
import { copyFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterNames = ['scan-campaigns.js', 'pause-campaign.js', 'whoami.js'];
const help = `Usage: node scripts/install.mjs [options]

  --skill-dir DIR    Install the self-contained skill (default: $CODEX_HOME/skills/qianniu-promotion-monitor)
  --opencli-dir DIR  Install adapters (default: ~/.opencli/clis/alimama)
  --config FILE     Migrate config.json only if absent or byte-for-byte identical
  --audit-from DIR  Add missing audit files; reject conflicting existing files
  --help            Show this help

Uses package.json's files allowlist plus package.json. Existing local config.json
and audit files are preserved. Changed code is backed up to a sibling .backups
directory with .bak filenames before replacement. No browsers or external commands are started.`;

export function parseArgs(args) {
  const options = {};
  const known = new Set(['--skill-dir', '--opencli-dir', '--config', '--audit-from']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') { options.help = true; continue; }
    if (!known.has(key)) throw new Error(`Unknown option: ${key}`);
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (options[key.slice(2)] !== undefined) throw new Error(`Duplicate option: ${key}`);
    options[key.slice(2)] = args[++i];
  }
  return options;
}

async function maybeStat(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Refuse links in existing destination ancestry so a migration cannot write elsewhere.
async function checkDestination(file) {
  let current = path.resolve(file);
  let isDestination = true;
  for (;;) {
    const info = await maybeStat(current);
    if (info?.isSymbolicLink()) throw new Error(`Symbolic links are not supported in installation paths: ${current}`);
    if (info && !isDestination && !info.isDirectory()) throw new Error(`Installation parent is not a directory: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    isDestination = false;
  }
}

async function collectFiles(directory, relative = '') {
  const current = path.join(directory, relative);
  const info = await lstat(current);
  if (info.isSymbolicLink()) throw new Error(`Symbolic links are not copied: ${current}`);
  if (info.isFile()) return [relative];
  if (!info.isDirectory()) throw new Error(`Not a regular file or directory: ${current}`);
  const entries = await readdir(current);
  const files = [];
  for (const entry of entries.sort()) files.push(...await collectFiles(directory, path.join(relative, entry)));
  return files;
}

function isPrivate(relative) {
  const parts = relative.split(/[\\/]/);
  return parts[0] === 'config.json' || parts[0] === 'audit'
    || parts.some(part => part === '.git' || part === 'node_modules' || part === '.env' || part.startsWith('.env.'));
}

async function publicFiles(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('package.json must contain a non-empty files allowlist');
  const files = new Set(['package.json']);
  for (const entry of manifest.files) {
    if (typeof entry !== 'string' || !entry || path.isAbsolute(entry) || /[*?{}[\]]/.test(entry)) {
      throw new Error('The files allowlist must contain literal relative file or directory paths');
    }
    const absolute = path.resolve(root, entry);
    if (!within(root, absolute) || absolute === root) throw new Error(`Invalid files allowlist path: ${entry}`);
    if (/[\\/]$/.test(entry) && !(await maybeStat(absolute))) continue;
    for (const relative of await collectFiles(root, path.relative(root, absolute))) {
      if (!isPrivate(relative)) files.add(relative);
    }
  }
  return [...files].sort();
}

export async function install(options = {}, root = sourceRoot) {
  const skillDir = path.resolve(options['skill-dir'] || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'qianniu-promotion-monitor'));
  const opencliDir = path.resolve(options['opencli-dir'] || path.join(os.homedir(), '.opencli', 'clis', 'alimama'));
  if ([skillDir, opencliDir].some(directory => path.dirname(directory) === directory)) throw new Error('Installation targets must not be filesystem roots');
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const plan = [];
  const destinations = new Map();
  let unchanged = 0;

  async function add(source, destination, destinationRoot, protectedFile = false) {
    await checkDestination(destination);
    const inputInfo = await lstat(source);
    if (!inputInfo.isFile() || inputInfo.isSymbolicLink()) throw new Error(`Source must be a regular file: ${source}`);
    const destinationInfo = await maybeStat(destination);
    if (destinationInfo && !destinationInfo.isFile()) throw new Error(`Destination must be a regular file: ${destination}`);
    const key = process.platform === 'win32' ? destination.toLowerCase() : destination;
    if (destinations.has(key)) {
      if (await realpath(destinations.get(key)) === await realpath(source)) return;
      throw new Error(`Installation targets overlap: ${destination}`);
    }
    destinations.set(key, source);
    if (destinationInfo) {
      if (await realpath(source) === await realpath(destination)) { unchanged++; return; }
      const [inputBytes, existingBytes] = await Promise.all([readFile(source), readFile(destination)]);
      if (inputBytes.equals(existingBytes)) { unchanged++; return; }
      if (protectedFile) throw new Error(`Refusing to overwrite different private data: ${destination}`);
    }
    const backup = destinationInfo
      ? `${path.join(`${destinationRoot}.backups`, runId, path.relative(destinationRoot, destination))}.bak`
      : null;
    if (backup) await checkDestination(backup);
    plan.push({ source, destination, backup });
  }

  // Preflight every file and conflict before making any change.
  for (const relative of await publicFiles(root)) {
    await add(path.join(root, relative), path.join(skillDir, relative), skillDir);
  }
  for (const name of adapterNames) await add(path.join(root, 'adapters', name), path.join(opencliDir, name), opencliDir);
  if (options.config) await add(path.resolve(options.config), path.join(skillDir, 'config.json'), skillDir, true);
  if (options['audit-from']) {
    const auditSource = path.resolve(options['audit-from']);
    const auditInfo = await lstat(auditSource);
    if (!auditInfo.isDirectory() || auditInfo.isSymbolicLink()) throw new Error('--audit-from must be a regular directory');
    for (const relative of await collectFiles(auditSource)) {
      await add(path.join(auditSource, relative), path.join(skillDir, 'audit', relative), skillDir, true);
    }
  }

  const backups = [];
  for (const item of plan) {
    if (item.backup) {
      await mkdir(path.dirname(item.backup), { recursive: true });
      await copyFile(item.destination, item.backup);
      backups.push(item.backup);
    }
    await mkdir(path.dirname(item.destination), { recursive: true });
    await copyFile(item.source, item.destination);
  }
  return { skillDir, opencliDir, copied: plan.length, unchanged, backups, configPresent: Boolean(await maybeStat(path.join(skillDir, 'config.json'))) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  const result = await install(options);
  console.log(`Skill: ${result.skillDir}\nAdapters: ${result.opencliDir}\nCopied ${result.copied}; unchanged ${result.unchanged}; backed up ${result.backups.length}.`);
  for (const directory of new Set(result.backups.map(file => path.dirname(file)))) console.log(`Backup: ${directory}`);
  if (!result.configPresent) console.log('Next: copy config.example.json to config.json and fill in the profile and shop identities.');
  console.log('Run node scripts/check.mjs from the installed skill directory to check local dependencies.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Installation failed: ${error.message}`); process.exitCode = 1; });
}

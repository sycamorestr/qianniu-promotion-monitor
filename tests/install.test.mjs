import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { install, parseArgs } from '../scripts/install.mjs';
import { checkEnvironment } from '../scripts/check.mjs';
import { resolveOpencli, validateConfig } from '../runner.mjs';

const names = ['scan-campaigns.js', 'pause-campaign.js', 'whoami.js'];
const config = {
  allowedBrowserUsers: ['Test shop'],
  profiles: [{ profile: 'test-profile', browserUser: 'Test shop', expectedAlimamaShop: 'Test shop' }],
  thresholds: { notifyRoiBelow: 2, closeChargeAbove: 30, closeRoiBelow: 1.5 },
  limits: { pageSize: 500, maxPages: 50, retries: 3 },
};

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qianniu-install-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('qianniu-install-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'source');
  const skill = path.join(directory, 'skill');
  const adapters = path.join(directory, 'opencli', 'alimama');
  await mkdir(path.join(source, 'adapters'), { recursive: true });
  await mkdir(path.join(source, 'scripts'), { recursive: true });
  await mkdir(path.join(source, 'audit'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', files: ['SKILL.md', 'runner.mjs', 'config.example.json', 'adapters/', 'scripts/'] }));
  await writeFile(path.join(source, 'SKILL.md'), 'Public instructions');
  await writeFile(path.join(source, 'runner.mjs'), '// fixture');
  await writeFile(path.join(source, 'config.example.json'), JSON.stringify(config));
  await writeFile(path.join(source, 'scripts', 'install.mjs'), '// fixture installer');
  await writeFile(path.join(source, 'config.json'), '{"private":true}');
  await writeFile(path.join(source, 'audit', 'private.json'), '{"private":true}');
  await writeFile(path.join(source, '.env'), 'PRIVATE=fixture');
  for (const name of names) await writeFile(path.join(source, 'adapters', name), `// ${name}`);
  return { directory, source, skill, adapters, options: { 'skill-dir': skill, 'opencli-dir': adapters } };
}

test('public allowlist installs an independent package and repeats without changes', async t => {
  const f = await fixture(t);
  const result = await install(f.options, f.source);
  assert.ok(result.copied > 0);
  assert.equal(result.configPresent, false);
  assert.deepEqual((await readdir(f.skill)).sort(), ['SKILL.md', 'adapters', 'config.example.json', 'package.json', 'runner.mjs', 'scripts'].sort());
  for (const name of names) assert.equal(await readFile(path.join(f.adapters, name), 'utf8'), `// ${name}`);
  const second = await install(f.options, f.source);
  assert.equal(second.copied, 0);
  assert.equal(second.backups.length, 0);
});

test('replacing code creates sibling backups and preserves destination private files', async t => {
  const f = await fixture(t);
  await install(f.options, f.source);
  await writeFile(path.join(f.skill, 'runner.mjs'), 'local modification');
  await writeFile(path.join(f.skill, 'SKILL.md'), 'old skill instructions');
  await writeFile(path.join(f.adapters, names[0]), 'old installed adapter');
  await writeFile(path.join(f.skill, 'config.json'), 'local config');
  await mkdir(path.join(f.skill, 'audit'));
  await writeFile(path.join(f.skill, 'audit', 'keep.json'), 'local audit');
  const result = await install(f.options, f.source);
  assert.equal(result.backups.length, 3);
  assert.equal(await readFile(result.backups.find(file => file.endsWith('runner.mjs.bak')), 'utf8'), 'local modification');
  assert.equal(await readFile(result.backups.find(file => file.endsWith('SKILL.md.bak')), 'utf8'), 'old skill instructions');
  assert.equal(await readFile(result.backups.find(file => file.endsWith(`${names[0]}.bak`)), 'utf8'), 'old installed adapter');
  assert.ok(result.backups.some(file => file.startsWith(`${f.skill}.backups${path.sep}`)));
  assert.ok(result.backups.some(file => file.startsWith(`${f.adapters}.backups${path.sep}`)));
  for (const backupRoot of [`${f.skill}.backups`, `${f.adapters}.backups`]) {
    const files = await readdir(backupRoot, { recursive: true, withFileTypes: true });
    const filenames = files.filter(entry => entry.isFile()).map(entry => entry.name);
    assert.ok(filenames.length > 0);
    assert.ok(filenames.every(name => name.endsWith('.bak')));
    assert.ok(filenames.every(name => name !== 'SKILL.md' && !name.endsWith('.js')));
  }
  assert.equal(await readFile(path.join(f.skill, 'config.json'), 'utf8'), 'local config');
  assert.equal(await readFile(path.join(f.skill, 'audit', 'keep.json'), 'utf8'), 'local audit');
});

test('explicit private migration is idempotent and rejects conflicts before code changes', async t => {
  const f = await fixture(t);
  const options = { ...f.options, config: path.join(f.source, 'config.json'), 'audit-from': path.join(f.source, 'audit') };
  await install(options, f.source);
  assert.equal(await readFile(path.join(f.skill, 'config.json'), 'utf8'), '{"private":true}');
  assert.equal((await install(options, f.source)).copied, 0);
  await writeFile(path.join(f.skill, 'runner.mjs'), 'keep until all preflight checks pass');
  await writeFile(path.join(f.source, 'config.json'), 'different config');
  await assert.rejects(install(options, f.source), /Refusing to overwrite different private data/);
  assert.equal(await readFile(path.join(f.skill, 'runner.mjs'), 'utf8'), 'keep until all preflight checks pass');
});

test('audit conflicts do not overwrite files or partially copy new audit files', async t => {
  const f = await fixture(t);
  const options = { ...f.options, 'audit-from': path.join(f.source, 'audit') };
  await install(options, f.source);
  await writeFile(path.join(f.source, 'audit', 'aaa-new.json'), 'new audit');
  await writeFile(path.join(f.source, 'audit', 'private.json'), 'different audit');
  await assert.rejects(install(options, f.source), /Refusing to overwrite different private data/);
  assert.deepEqual(await readdir(path.join(f.skill, 'audit')), ['private.json']);
  assert.equal(await readFile(path.join(f.skill, 'audit', 'private.json'), 'utf8'), '{"private":true}');
});

test('source equals destination is a safe no-op', async t => {
  const f = await fixture(t);
  const result = await install({ 'skill-dir': f.source, 'opencli-dir': path.join(f.source, 'adapters'), config: path.join(f.source, 'config.json'), 'audit-from': path.join(f.source, 'audit') }, f.source);
  assert.equal(result.copied, 0);
  assert.equal(result.backups.length, 0);
});

test('invalid allowlist paths are rejected before creating installation destinations', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'package.json'), JSON.stringify({ files: ['../secret.json'] }));
  await assert.rejects(install(f.options, f.source), /Invalid files allowlist path/);
  await assert.rejects(readdir(f.skill), { code: 'ENOENT' });
  assert.throws(() => parseArgs(['--skill-dir']), /Missing value/);
});

test('configuration supports any non-zero shop count and rejects duplicate or untrusted identities', () => {
  assert.equal(validateConfig(config).profiles.length, 1);
  assert.throws(() => validateConfig({ ...config, profiles: [] }), /at least one/);
  assert.throws(() => validateConfig({ ...config, profiles: [...config.profiles, config.profiles[0]] }), /Duplicate profile/);
  assert.throws(() => validateConfig({ ...config, allowedBrowserUsers: ['Different shop'] }), /not in allowedBrowserUsers/);
  assert.throws(() => validateConfig({ ...config, profiles: [{ ...config.profiles[0], expectedAlimamaShop: '' }] }), /requires expectedAlimamaShop/);
});

test('Windows launcher selection prefers PowerShell and rejects batch-only installations', async t => {
  const f = await fixture(t);
  const bin = path.join(f.directory, 'bin');
  await mkdir(bin);
  for (const name of ['opencli', 'opencli.ps1', 'opencli.exe', 'opencli.cmd']) await writeFile(path.join(bin, name), 'fixture');
  const launch = resolveOpencli({ PATH: bin }, 'win32');
  assert.equal(launch.command, 'pwsh.exe');
  assert.equal(launch.prefix.at(-1), path.join(bin, 'opencli.ps1'));
  const batchDir = path.join(f.directory, 'batch-only');
  await mkdir(batchDir);
  await writeFile(path.join(batchDir, 'opencli.cmd'), 'fixture');
  assert.throws(() => resolveOpencli({ PATH: batchDir }, 'win32'), /OpenCLI not found/);
  assert.throws(() => resolveOpencli({ OPENCLI_BIN: path.join(batchDir, 'opencli.cmd') }, 'win32'), /\.cmd\/\.bat/);
});

test('dependency checks locate fake commands without execution and keep webhook values private', async t => {
  const f = await fixture(t);
  await install(f.options, f.source);
  const configPath = path.join(f.directory, 'test-config.json');
  await writeFile(configPath, JSON.stringify(config));
  const executable = path.join(f.directory, process.platform === 'win32' ? 'opencli.exe' : 'opencli');
  await writeFile(executable, 'This file must never be executed.');
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  const env = { OPENCLI_BIN: executable, PATH: '' };
  const options = { config: configPath, 'opencli-dir': f.adapters };
  assert.equal((await checkEnvironment(options, f.source, env)).ok, true);
  assert.equal((await checkEnvironment({ ...options, mode: 'execute' }, f.source, env)).ok, false);
  const withWebhook = await checkEnvironment({ ...options, mode: 'dry-run' }, f.source, { ...env, WECHAT_WEBHOOK_URL: 'private-fixture-value' });
  assert.equal(withWebhook.ok, true);
  assert.ok(!JSON.stringify(withWebhook).includes('private-fixture-value'));
  await writeFile(path.join(f.adapters, names[0]), 'different');
  assert.equal((await checkEnvironment(options, f.source, env)).ok, false);
});

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildMessages } from './messages.mjs';
export { buildMessages, splitMessages, splitShopMessages } from './messages.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const promotionTypes = new Set(['全站推', '关键词推广']);
const defaults = { notifyRoiBelow: 2, closeChargeAbove: 30, closeRoiBelow: 1.5 };

// Authentication failures are terminal for the current browser profile. Retrying a
// command cannot recreate an expired login session and only adds noise or load. Keep
// this matcher deliberately narrow; a generic page/API failure must remain retryable.
const authenticationErrorPatterns = [
  /logged[- ]?in shop identity is unavailable/i,
  /(?:authentication|authorization|login|sign[- ]?in) required/i,
  /not logged[- ]?in/i,
  /(?:login|session|cookie).*(?:expired|invalid|失效|过期)/i,
  /(?:未登录|未登陆|登录(?:态)?(?:已)?(?:过期|失效)|登陆(?:态)?(?:已)?(?:过期|失效)|会话(?:已)?(?:过期|失效)|认证失败)/,
  /\b401\b/,
  /(?:passport|login)\.(?:taobao|tmall|alimama)\./i,
];

export function isAuthenticationError(error) {
  if (error?.code === 'AUTH_REQUIRED' || error?.authRequired === true) return true;
  const message = String(error?.message || error || '');
  return authenticationErrorPatterns.some(pattern => pattern.test(message));
}

function opencliFailure(message, diagnostics = '') {
  const error = new Error(message);
  if (authenticationErrorPatterns.some(pattern => pattern.test(String(diagnostics)))) {
    error.code = 'AUTH_REQUIRED';
    error.authRequired = true;
    error.retryable = false;
    error.message = 'OpenCLI reports that the Alimama login session is unavailable; sign in again before retrying';
  }
  return error;
}

export function parseArgs(args) {
  const options = { mode: 'report', configPath: path.join(root, 'config.json'), auditDir: path.join(root, 'audit') };
  const keys = { '--mode': 'mode', '--config': 'configPath', '--audit-dir': 'auditDir',
    '--recover': 'recover', '--finalize': 'finalize', '--settled-profiles': 'settledProfiles' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true };
    if (args[i] === '--retry-pauses') { options.retryPauses = true; continue; }
    const [flag, ...rest] = args[i].split('=');
    if (!keys[flag]) throw new Error(`Unknown argument: ${flag}`);
    const value = rest.length ? rest.join('=') : args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    options[keys[flag]] = value;
  }
  if (!['report', 'dry-run', 'execute'].includes(options.mode)) throw new Error('mode must be report, dry-run, or execute');
  if (options.recover && options.finalize) throw new Error('Choose recover or finalize');
  if ((options.retryPauses || options.settledProfiles) && !options.recover) throw new Error('Retry options require --recover');
  for (const id of [options.recover, options.finalize].filter(Boolean)) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid audit run ID');
  }
  options.configPath = path.resolve(options.configPath);
  options.auditDir = path.resolve(options.auditDir);
  return options;
}

export function validateConfig(config) {
  if (!Array.isArray(config?.profiles) || !config.profiles.length) throw new Error('Configure at least one profile');
  if (!Array.isArray(config.allowedBrowserUsers) || !config.allowedBrowserUsers.length) throw new Error('allowedBrowserUsers must contain the permitted browser user names');
  if (config.allowedBrowserUsers.some(value => typeof value !== 'string' || !value.trim())) throw new Error('allowedBrowserUsers must contain non-empty names');
  const profiles = new Set();
  for (const row of config.profiles) {
    for (const field of ['profile', 'browserUser', 'expectedAlimamaShop']) {
      if (typeof row?.[field] !== 'string' || !row[field].trim()) throw new Error(`Every profile requires ${field}`);
      if (row[field] !== row[field].trim()) throw new Error(`Remove surrounding whitespace from ${field}`);
    }
    if (!config.allowedBrowserUsers.includes(row.browserUser)) throw new Error('A browserUser is not in allowedBrowserUsers');
    if (profiles.has(row.profile)) throw new Error('Duplicate profile in config');
    profiles.add(row.profile);
  }
  const thresholds = { ...defaults, ...config.thresholds };
  for (const [key, value] of Object.entries(thresholds)) {
    if (!(key in defaults) || !Number.isFinite(value) || value < 0) throw new Error(`Invalid threshold: ${key}`);
  }
  const limits = { pageSize: 500, maxPages: 50, retries: 3, ...config.limits };
  for (const [key, max] of [['pageSize', 500], ['maxPages', 200], ['retries', 10]]) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > max) throw new Error(`Invalid limit: ${key}`);
  }
  return { ...config, thresholds, limits };
}

// Use PATH (or a literal OPENCLI_BIN path); do not depend on a package manager's installation directory.
export function resolveOpencli(env = process.env, platform = process.platform) {
  const explicit = env.OPENCLI_BIN;
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const names = explicit
    ? (platform === 'win32' && !path.extname(explicit) ? [`${explicit}.ps1`, `${explicit}.exe`] : [explicit])
    : platform === 'win32' ? ['opencli.ps1', 'opencli.exe'] : ['opencli'];
  const candidates = names.flatMap(name => path.isAbsolute(name) || /[\\/]/.test(name)
    ? [path.resolve(name)]
    : pathValue.split(path.delimiter).filter(Boolean).map(dir => path.join(dir.replace(/^"|"$/g, ''), name)));
  const binary = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!binary) throw new Error('OpenCLI not found; add it to PATH or set OPENCLI_BIN to its executable / .ps1 path');
  if (/\.(cmd|bat)$/i.test(binary)) throw new Error('Use the OpenCLI .ps1 launcher on Windows, rather than a .cmd/.bat launcher');
  if (platform === 'win32' && !/\.(ps1|exe)$/i.test(binary)) throw new Error('OPENCLI_BIN must resolve to an .exe or .ps1 launcher on Windows');
  return /\.ps1$/i.test(binary)
    ? { command: 'pwsh.exe', prefix: ['-NoProfile', '-NonInteractive', '-File', binary] }
    : { command: binary, prefix: [] };
}

export const minimumOpencliOuterTimeoutMs = commandSeconds => (commandSeconds * 2 + 60) * 1000;

export function validateOpencliTimeoutBudget(timeout, commandSeconds) {
  if (!Number.isFinite(commandSeconds) || commandSeconds < 1 || timeout < minimumOpencliOuterTimeoutMs(commandSeconds)) {
    throw new Error('OPENCLI_TIMEOUT_MS must cover two command/failure-evidence timeouts plus 60 seconds of shutdown headroom');
  }
}

export function createOpencli(env) {
  const launch = resolveOpencli(env);
  const timeout = Number(env.OPENCLI_TIMEOUT_MS || 420000);
  if (!Number.isFinite(timeout) || timeout < 1000) throw new Error('OPENCLI_TIMEOUT_MS must be at least 1000');
  return args => {
    const timeoutIndex = args.indexOf('--timeout');
    if (timeoutIndex >= 0) {
      const commandSeconds = Number(args[timeoutIndex + 1]);
      validateOpencliTimeoutBudget(timeout, commandSeconds);
    }
    const proc = spawnSync(launch.command, [...launch.prefix, ...args], {
      encoding: 'utf8', timeout, env, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    });
    // Do not copy browser traces or arbitrary stderr (which may contain session data) into audit files.
    const diagnostics = `${proc.stdout || ''}\n${proc.stderr || ''}`;
    if (proc.error) throw opencliFailure(`OpenCLI process failed (${proc.error.code || 'unknown'}); inspect its local trace`, diagnostics);
    if (proc.status !== 0) throw opencliFailure(`OpenCLI exited with status ${proc.status}; inspect its local trace`, diagnostics);
    try { return JSON.parse(proc.stdout); }
    catch { throw new Error('OpenCLI returned invalid JSON'); }
  };
}

export function validateScan(rows, identity) {
  if (!Array.isArray(rows)) throw new Error('Scan result must be an array');
  const identities = rows.filter(row => row?.recordType === 'identity');
  if (identities.length !== 1 || identities[0].shopName !== identity.expectedAlimamaShop) throw new Error('Shop identity mismatch in scan');
  return rows.filter(row => row?.recordType !== 'identity').map(row => {
    if (row.recordType !== 'campaign' || row.shopName !== identity.expectedAlimamaShop) throw new Error('Campaign shop identity mismatch');
    if (!promotionTypes.has(row.promotionType) || typeof row.campaignId !== 'string' || !row.campaignId.trim()
      || typeof row.campaignName !== 'string' || !row.campaignName.trim()) throw new Error('Invalid campaign identity');
    for (const field of ['roi', 'charge']) {
      if (row[field] !== null && !Number.isFinite(row[field])) throw new Error(`Invalid campaign ${field}`);
    }
    return { ...row, profile: identity.profile, browserUser: identity.browserUser };
  });
}

export function validateVerification(rows, identity, targets) {
  if (!Array.isArray(rows) || rows.filter(row => row?.recordType === 'identity').length !== 1
      || rows.find(row => row?.recordType === 'identity').shopName !== identity.expectedAlimamaShop) {
    throw new Error('Shop identity mismatch in target verification');
  }
  const observations = rows.filter(row => row.recordType !== 'identity');
  if (observations.length !== targets.length) throw new Error('Target verification is incomplete');
  return targets.map(target => {
    const matches = observations.filter(row => row.promotionType === target.promotionType
      && String(row.campaignId) === target.campaignId);
    if (matches.length !== 1) throw new Error('Target verification identity mismatch');
    const row = matches[0];
    if (row.recordType !== 'verification' || row.shopName !== identity.expectedAlimamaShop) throw new Error('Invalid target verification');
    const nameMatches = row.campaignName === target.campaignName;
    const inactive = nameMatches && row.verified === true && row.outcome === 'inactive'
      && row.displayStatus === 'pause' && row.onlineStatus === 0;
    const isActive = nameMatches && row.verified === true && row.outcome === 'active' && active(row);
    return { ...target, ...row, profile: identity.profile, browserUser: identity.browserUser,
      outcome: inactive ? 'inactive' : isActive ? 'active' : nameMatches ? 'unverified' : 'identity-mismatch',
      verified: inactive || isActive };
  });
}

export const targetArgs = rows => ['--targets', JSON.stringify(rows.map(row => ({ promotionType: row.promotionType,
  campaignId: row.campaignId, campaignName: row.campaignName })))];

export const targetGroups = rows => ['全站推', '关键词推广']
  .map(promotionType => rows.filter(row => row.promotionType === promotionType))
  .filter(rowsOfType => rowsOfType.length);

export function commandTimeoutArgs(env) {
  const seconds = Number(env.OPENCLI_BROWSER_COMMAND_TIMEOUT || 180);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error('OPENCLI_BROWSER_COMMAND_TIMEOUT must be 1..3600 seconds');
  }
  return ['--timeout', String(seconds)];
}

export const active = row => row.displayStatus === 'start' && row.onlineStatus === 1;
export const keyOf = row => `${row.profile}|${row.promotionType}|${row.campaignId}`;
export function selectCampaigns(rows, thresholds) {
  return {
    lowRoi: rows.filter(row => active(row) && Number.isFinite(row.roi) && row.roi < thresholds.notifyRoiBelow),
    toClose: rows.filter(row => active(row) && Number.isFinite(row.roi) && Number.isFinite(row.charge)
      && row.charge > thresholds.closeChargeAbove && row.roi < thresholds.closeRoiBelow),
  };
}

export function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, filePath);
}


export async function sendWeChat(webhook, content) {
  const response = await fetch(webhook, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if ((await response.json()).errcode !== 0) throw new Error('WeCom rejected the notification');
}

// Lock audit mutations and recovery writes across processes, including notification finalization.
export async function run(options, dependencies = {}) {
  fs.mkdirSync(options.auditDir, { recursive: true });
  const lockPath = path.join(options.auditDir, 'runner.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* fail closed */ }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) throw new Error('Runner lock needs agent inspection');
    try { process.kill(owner.pid, 0); }
    catch (probe) {
      if (probe.code === 'ESRCH') {
        throw new Error('Stale runner lock; agent must inspect and remove this lock before recovery');
      }
      throw new Error('Cannot verify runner lock owner');
    }
    throw new Error('Another runner is active; wait for it before recovery');
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await runUnlocked(options, dependencies);
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

// Dependencies are injectable solely for offline verification; the CLI always uses the actual OpenCLI launcher.
async function runUnlocked(options, dependencies) {
  const env = dependencies.env || process.env;
  let config;
  try { config = JSON.parse(fs.readFileSync(options.configPath, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid JSON in config file');
    throw new Error(`Cannot read config file (${error.code || 'read error'})`);
  }
  config = validateConfig(config);
  if (options.recover || options.finalize) {
    const { recoverAudit } = await import('./recovery.mjs');
    return recoverAudit(options, config, dependencies);
  }
  if (!['report', 'dry-run', 'execute'].includes(options.mode)) throw new Error('Invalid mode');
  const webhook = env.WECHAT_WEBHOOK_URL;
  if (options.mode !== 'report') {
    if (!webhook) throw new Error('WECHAT_WEBHOOK_URL is required for dry-run/execute');
    try { if (new URL(webhook).protocol !== 'https:') throw new Error(); }
    catch { throw new Error('WECHAT_WEBHOOK_URL must be an HTTPS URL'); }
  }
  const attempts = Number(env.OPENCLI_RETRIES || config.limits.retries);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new Error('OPENCLI_RETRIES must be 1..10');
  const callOpencli = dependencies.callOpencli || createOpencli(env);
  const send = dependencies.send || sendWeChat;
  const log = dependencies.log || (message => console.error(message));
  fs.mkdirSync(options.auditDir, { recursive: true });
  if (options.mode === 'execute') {
    const unfinishedExecute = fs.readdirSync(options.auditDir)
      .filter(name => name.endsWith('.partial.json'))
      .some(name => {
        try {
          return JSON.parse(fs.readFileSync(path.join(options.auditDir, name), 'utf8')).mode === 'execute';
        } catch {
          return true;
        }
      });
    if (unfinishedExecute) throw new Error('An unfinished execute checkpoint exists; inspect current campaign status before retrying');
  }
  const runId = `${new Date().toISOString().slice(0, 10)}-${Date.now()}-${process.pid}`;
  const checkpointPath = path.join(options.auditDir, `${runId}.partial.json`);
  const finalPath = path.join(options.auditDir, `${runId}.json`);
  const statePath = path.join(options.auditDir, 'state.json');
  const state = options.mode === 'execute' && fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { paused: {} };
  if (!state.paused || typeof state.paused !== 'object' || Array.isArray(state.paused)) throw new Error('Invalid pause state file');
  state.pending ||= {};
  if (typeof state.pending !== 'object' || Array.isArray(state.pending)) throw new Error('Invalid pending state file');
  // Pending writes are isolated by promotion plan. A stale/uncertain plan must
  // not suppress independent eligible plans from the same shop profile.
  const blockedKeys = new Set(Object.keys(state.pending));
  const inheritedBlockedKeys = new Set(blockedKeys);
  const pendingRuns = [...new Set(Object.values(state.pending).map(row => row.runId).filter(Boolean))];
  const results = [], failures = [], closeResults = [], pauseReadbacks = [], shops = [], seen = new Set(), pauseAttempts = [];
  const authBlockedProfiles = new Set();
  const configSnapshot = { profiles: config.profiles, allowedBrowserUsers: config.allowedBrowserUsers,
    thresholds: config.thresholds, limits: config.limits };
  const checkpoint = current => atomicJson(checkpointPath,
    { runId, mode: options.mode, configSnapshot, current, results, shops, failures, closeResults, pauseReadbacks, pauseAttempts });
  const lifecycle = ['-f', 'json', '--window', 'background', '--site-session', 'ephemeral', '--keep-tab', 'false'];
  const pagination = ['--page-size', String(config.limits.pageSize), '--max-pages', String(config.limits.maxPages)];
  const commandTimeout = commandTimeoutArgs(env);

  for (const [index, identity] of config.profiles.entries()) {
    log(`[${index + 1}/${config.profiles.length}] ${identity.browserUser}: scan`);
    checkpoint({ type: 'scan', profile: identity.profile });
    let rows, lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        rows = validateScan(await callOpencli(['--profile', identity.profile, 'alimama', 'scan-campaigns', ...pagination,
          ...commandTimeout, '--trace', 'retain-on-failure', ...lifecycle]), identity);
        break;
      } catch (error) {
        lastError = error;
        if (isAuthenticationError(error)) {
          authBlockedProfiles.add(identity.profile);
          break;
        }
      }
    }
    shops.push({ profile: identity.profile, browserUser: identity.browserUser, ok: !!rows });
    if (!rows) failures.push({ profile: identity.profile, browserUser: identity.browserUser, type: 'scan',
      ...(isAuthenticationError(lastError) ? { reason: 'auth-required', retryable: false } : {}), message: lastError.message });
    else for (const row of rows) if (!seen.has(keyOf(row))) { seen.add(keyOf(row)); results.push(row); }
    checkpoint({ type: 'scan', profile: identity.profile, done: true });
  }

  const { lowRoi, toClose } = selectCampaigns(results, config.thresholds);
  if (options.mode === 'execute') for (const row of toClose) {
    const identity = config.profiles.find(item => item.profile === row.profile);
    if (authBlockedProfiles.has(row.profile)) continue;
    if (blockedKeys.has(keyOf(row))) continue;
    // Persist intent before a write. An interrupted / uncertain write must be read back before any retry.
    pauseAttempts.push({ ...row, attempt: 1, status: 'pending', sessionMode: 'persistent', at: new Date().toISOString() });
    state.pending[keyOf(row)] = { ...row, runId, attempts: 1, status: 'pending' };
    atomicJson(statePath, state);
    checkpoint({ type: 'pause', profile: row.profile, promotionType: row.promotionType, campaignId: row.campaignId, status: 'pending' });
    try {
      const raw = await callOpencli(['--profile', row.profile, 'alimama', 'pause-campaign',
        '--promotion-type', row.promotionType === '关键词推广' ? 'keyword' : 'all-site',
        '--campaign-id', row.campaignId, '--expected-shop', identity.expectedAlimamaShop,
        '--expected-name', row.campaignName, '--max-roi', String(config.thresholds.closeRoiBelow),
        '--min-charge', String(config.thresholds.closeChargeAbove), ...pagination,
        ...commandTimeout, '--execute', '--trace', 'retain-on-failure', ...lifecycle.map((value, index) => lifecycle[index - 1] === '--site-session' ? 'persistent' : value)]);
      const result = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
      if (result?.ok !== true || result.verified !== true || result.shopName !== identity.expectedAlimamaShop
        || result.promotionType !== row.promotionType || String(result.campaignId) !== row.campaignId
        || result.campaignName !== row.campaignName || result.writeAttempted !== true
        || !['pause', 'not-in-active-list'].includes(result.afterStatus)) {
        throw new Error('Pause result did not confirm the expected campaign');
      }
      const verified = { ...result, profile: row.profile, browserUser: row.browserUser };
      const nextPaused = { ...state.paused, [keyOf(row)]: { at: new Date().toISOString(), runId, result: verified } };
      delete state.pending[keyOf(row)];
      atomicJson(statePath, { ...state, paused: nextPaused });
      state.paused = nextPaused;
      closeResults.push(verified);
      pauseAttempts.at(-1).status = 'verified';
    } catch (error) {
      pauseAttempts.at(-1).status = 'uncertain';
      if (isAuthenticationError(error)) authBlockedProfiles.add(row.profile);
      blockedKeys.add(keyOf(row));
      failures.push({ profile: row.profile, browserUser: row.browserUser, type: 'pause', campaignId: row.campaignId,
        ...(isAuthenticationError(error) ? { reason: 'auth-required', retryable: false } : {}), message: error.message });
    }
    checkpoint({ type: 'pause', profile: row.profile, campaignId: row.campaignId, done: true });
  }

  if (options.mode === 'execute') {
    const verified = new Set(closeResults.map(keyOf));
    const pendingByProfile = new Map();
    for (const row of toClose) {
      if (verified.has(keyOf(row))) continue;
      if (!pendingByProfile.has(row.profile)) pendingByProfile.set(row.profile, []);
      pendingByProfile.get(row.profile).push(row);
    }

    for (const [profile, pending] of pendingByProfile) {
      const identity = config.profiles.find(item => item.profile === profile);
      for (const group of targetGroups(pending)) {
        const promotionType = group[0].promotionType;
        const readback = {
          profile,
          promotionType,
          browserUser: identity.browserUser,
          expectedAlimamaShop: identity.expectedAlimamaShop,
          ok: false,
          campaigns: [],
        };
        log(`${identity.browserUser}: final ${promotionType} pause read-back`);
        checkpoint({ type: 'pause-readback', profile, promotionType, status: 'pending' });
        if (authBlockedProfiles.has(profile)) {
          readback.error = 'Login session unavailable; read-back deferred until the shop is signed in again';
          readback.campaigns = group.map(row => ({
            promotionType: row.promotionType, campaignId: row.campaignId, expectedCampaignName: row.campaignName,
            outcome: 'unverified', verified: false, current: null,
          }));
          readback.checkedAt = new Date().toISOString();
          pauseReadbacks.push(readback);
          failures.push({ profile, promotionType, browserUser: identity.browserUser,
            type: 'pause-readback', reason: 'auth-required', retryable: false, message: readback.error });
          checkpoint({ type: 'pause-readback', profile, promotionType, done: true });
          continue;
        }
        try {
          const currentRows = validateVerification(await callOpencli([
            '--profile', profile, 'alimama', 'scan-campaigns', ...targetArgs(group), ...pagination,
            ...commandTimeout, '--trace', 'retain-on-failure', ...lifecycle,
          ]), identity, group);
          readback.ok = true;
          for (const current of currentRows) {
            const row = group.find(item => keyOf(item) === keyOf(current));
            readback.campaigns.push({
              promotionType: row.promotionType, campaignId: row.campaignId, expectedCampaignName: row.campaignName,
              outcome: current.outcome, verified: current.verified, current,
            });
            if (current.outcome === 'inactive') {
              const verifiedResult = { ...row, ok: true, verified: true, afterStatus: 'pause',
                writeAttempted: null, verificationSource: 'final-readback' };
              closeResults.push(verifiedResult);
              state.paused[keyOf(row)] = { at: new Date().toISOString(), runId, result: verifiedResult };
              delete state.pending[keyOf(row)];
            } else if (current.outcome === 'active' && Number.isFinite(current.roi) && Number.isFinite(current.charge)
                && !selectCampaigns([current], config.thresholds).toClose.length) {
              delete state.pending[keyOf(row)];
            }
          }
          atomicJson(statePath, state);
        } catch (error) {
          readback.error = error.message;
          readback.campaigns = group.map(row => ({
            promotionType: row.promotionType, campaignId: row.campaignId, expectedCampaignName: row.campaignName,
            outcome: 'unverified', verified: false, current: null,
          }));
          failures.push({ profile, promotionType, browserUser: identity.browserUser,
            type: 'pause-readback', message: error.message });
        }
        readback.checkedAt = new Date().toISOString();
        pauseReadbacks.push(readback);
        checkpoint({ type: 'pause-readback', profile, promotionType, done: true });
      }
    }
  }

  const payload = { runAt: new Date().toISOString(), runId, mode: options.mode, configSnapshot, scanned: results.length,
    shops, lowRoi, toClose, closeResults, pauseReadbacks, failures, pauseAttempts, pendingRuns,
    notification: { status: options.mode === 'report' ? 'disabled' : 'not-needed', sent: 0 } };
  if (options.mode !== 'report') {
    const { unresolvedItems } = await import('./recovery.mjs');
    const unresolved = unresolvedItems(payload, config);
    if (options.mode === 'execute' && pendingRuns.length) {
      unresolved.push(...pendingRuns.map(id => ({ type: 'prior-run', runId: id })));
    }
    if (unresolved.length) {
      payload.recovery = { status: 'awaiting-agent', rounds: 0, unresolved };
      payload.notification.status = 'awaiting-agent';
      if (options.mode === 'execute') {
        for (const row of toClose) {
          if (inheritedBlockedKeys.has(keyOf(row))) continue;
          if (!unresolved.some(item => item.profile === row.profile && item.campaignId === row.campaignId
            && item.promotionType === row.promotionType)) continue;
          state.pending[keyOf(row)] ||= { ...row, runId, status: 'awaiting-agent' };
        }
        atomicJson(statePath, state);
      }
      atomicJson(finalPath, payload);
      fs.unlinkSync(checkpointPath);
      log(`Agent recovery required: node runner.mjs --recover ${runId}; finalize only after recovery`);
      return payload;
    }
  }
  atomicJson(finalPath, payload);
  if (options.mode !== 'report' && (lowRoi.length || toClose.length || failures.length)) {
    payload.notification.status = 'sending';
    atomicJson(finalPath, payload);
    try {
      for (const content of buildMessages(payload, config)) {
        await send(webhook, content);
        payload.notification.sent++;
        atomicJson(finalPath, payload);
      }
      payload.notification.status = 'sent';
    } catch {
      // Never replay the complete workflow or uncertain notification sends automatically.
      payload.notification.status = 'failed';
      failures.push({ type: 'notification', message: 'Final notification failed; inspect saved results before sending again' });
    }
    atomicJson(finalPath, payload);
  }
  fs.unlinkSync(checkpointPath);
  return payload;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('node runner.mjs [--mode report|dry-run|execute] [--config FILE] [--audit-dir DIR]\nnode runner.mjs --recover RUN_ID [--retry-pauses --settled-profiles PROFILE,PROFILE]\nnode runner.mjs --finalize RUN_ID\nDefault: report. Recovery reads only unless an agent explicitly enables a guarded retry. Finalize sends saved results only.');
    else {
      const payload = await run(options);
      console.log(JSON.stringify(payload, null, 2));
      if (payload.recovery?.status === 'awaiting-agent') process.exitCode = 2;
      else if (payload.notification.status === 'failed' || payload.recovery?.unresolved?.length
        || (!payload.recovery && payload.failures.some(row => row.type !== 'pause'))) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();

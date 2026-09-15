import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const promotionTypes = new Set(['全站推', '关键词推广']);
const defaults = { notifyRoiBelow: 2, closeChargeAbove: 30, closeRoiBelow: 1.5 };

export function parseArgs(args) {
  const options = { mode: 'report', configPath: path.join(root, 'config.json'), auditDir: path.join(root, 'audit') };
  const keys = { '--mode': 'mode', '--config': 'configPath', '--audit-dir': 'auditDir' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true };
    const [flag, ...rest] = args[i].split('=');
    if (!keys[flag]) throw new Error(`Unknown argument: ${flag}`);
    const value = rest.length ? rest.join('=') : args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    options[keys[flag]] = value;
  }
  if (!['report', 'dry-run', 'execute'].includes(options.mode)) throw new Error('mode must be report, dry-run, or execute');
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

function createOpencli(env) {
  const launch = resolveOpencli(env);
  const timeout = Number(env.OPENCLI_TIMEOUT_MS || 120000);
  if (!Number.isFinite(timeout) || timeout < 1000) throw new Error('OPENCLI_TIMEOUT_MS must be at least 1000');
  return args => {
    const proc = spawnSync(launch.command, [...launch.prefix, ...args], {
      encoding: 'utf8', timeout, env, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    });
    // Do not copy browser traces or arbitrary stderr (which may contain session data) into audit files.
    if (proc.error) throw new Error(`OpenCLI process failed (${proc.error.code || 'unknown'}); inspect its local trace`);
    if (proc.status !== 0) throw new Error(`OpenCLI exited with status ${proc.status}; inspect its local trace`);
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

const active = row => row.displayStatus === 'start' && row.onlineStatus === 1;
const keyOf = row => `${row.profile}|${row.promotionType}|${row.campaignId}`;
export function selectCampaigns(rows, thresholds) {
  return {
    lowRoi: rows.filter(row => active(row) && Number.isFinite(row.roi) && row.roi < thresholds.notifyRoiBelow),
    toClose: rows.filter(row => active(row) && Number.isFinite(row.roi) && Number.isFinite(row.charge)
      && row.charge > thresholds.closeChargeAbove && row.roi < thresholds.closeRoiBelow),
  };
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, filePath);
}

const safeText = value => String(value ?? '-').replace(/[\r\n\t]/g, ' ').replace(/[<>&`*_\[\]]/g, '');
const metric = value => Number.isFinite(value) ? value.toFixed(2) : '-';
const color = (name, value) => `<font color="${name}">${value}</font>`;
const compactText = (value, maxCharacters = 80) => {
  const characters = [...safeText(value)];
  return characters.length <= maxCharacters ? characters.join('') : `${characters.slice(0, maxCharacters - 3).join('')}...`;
};
const campaignDetails = row => `${safeText(row.promotionType)}｜花费 ${metric(row.charge)}｜ROI ${metric(row.roi)}｜ID ${safeText(row.campaignId)}`;
const pauseLine = (row, label, statusColor) => `- ${color(statusColor, label)}｜${compactText(row.campaignName)}｜${color('comment', campaignDetails(row))}`;
const lowRoiLine = row => `- ${compactText(row.campaignName)}｜${safeText(row.promotionType)}｜花费 ${metric(row.charge)}｜ROI ${color('warning', metric(row.roi))}｜${color('comment', `ID ${safeText(row.campaignId)}`)}`;

export function splitMessages(header, lines, maxBytes = 4000) {
  if (Buffer.byteLength(header, 'utf8') > maxBytes - 8) throw new Error('Notification header too long');
  const parts = [];
  let current = header;
  for (const line of lines) {
    // Split even a single exceptionally long plan name without splitting UTF-8 code points.
    for (const character of `\n${line}`) {
      if (Buffer.byteLength(current + character, 'utf8') > maxBytes) {
        parts.push(current);
        current = `${header}\n`;
      }
      current += character;
    }
  }
  if (current) parts.push(current);
  return parts;
}

const appendBlock = (content, block) => `${content}\n${block}`;
const fits = (content, maxBytes) => Buffer.byteLength(content, 'utf8') <= maxBytes;

// Keep shop and subsection context intact when a large shop needs several WeCom messages.
export function splitShopMessages(header, sections, maxBytes = 4000) {
  if (Buffer.byteLength(header, 'utf8') > maxBytes - 8) throw new Error('Notification header too long');
  const parts = [];
  let current = header;
  const flush = () => {
    if (current !== header) parts.push(current);
    current = header;
  };
  const shopPrefix = (section, continuation = false, groupHeading = '') => [
    header,
    continuation ? `${section.heading} ${color('comment', '（续）')}` : section.heading,
    section.summary,
    groupHeading,
  ].filter(Boolean).join('\n');

  for (const section of sections) {
    const block = [section.heading, section.summary,
      ...section.groups.flatMap(group => [group.heading, ...group.lines])].filter(Boolean).join('\n');
    if (fits(appendBlock(current, block), maxBytes)) {
      current = appendBlock(current, block);
      continue;
    }
    if (current !== header) flush();
    if (fits(appendBlock(header, block), maxBytes)) {
      current = appendBlock(header, block);
      continue;
    }

    current = shopPrefix(section);
    if (!fits(current, maxBytes)) throw new Error('Notification shop heading is too long');
    for (const group of section.groups) {
      if (!group.lines.length) continue;
      const first = `${group.heading}\n${group.lines[0]}`;
      if (!fits(appendBlock(current, first), maxBytes)) {
        flush();
        current = shopPrefix(section, true);
      }
      if (!fits(appendBlock(current, first), maxBytes)) throw new Error('Notification line is too long for its shop context');
      current = appendBlock(current, first);
      for (const line of group.lines.slice(1)) {
        if (!fits(appendBlock(current, line), maxBytes)) {
          flush();
          current = shopPrefix(section, true, group.heading);
        }
        if (!fits(appendBlock(current, line), maxBytes)) throw new Error('Notification line is too long for its shop context');
        current = appendBlock(current, line);
      }
    }
  }
  flush();
  return parts;
}

export function buildMessages(payload, config) {
  const completed = payload.shops.filter(shop => shop.ok).length;
  const failedShops = config.profiles.length - completed;
  const verified = new Set(payload.closeResults.map(keyOf));
  const freshActive = new Map();
  for (const readback of payload.pauseReadbacks || []) {
    for (const result of readback.campaigns || []) {
      if (result.outcome === 'active' && result.current) {
        freshActive.set(`${readback.profile}|${result.promotionType}|${result.campaignId}`, result.current);
      }
    }
  }
  const displayRow = row => ({ ...row, ...(freshActive.get(keyOf(row)) || {}) });
  const stopped = payload.toClose.filter(row => verified.has(keyOf(row))).length;
  const notStopped = payload.toClose.length - stopped;
  const pauseOutcomeCounts = (paused, unpaused) => [
    paused ? color('info', `推广已暂停 ${paused} 个`) : '',
    unpaused ? color('warning', `推广未暂停 ${unpaused} 个`) : '',
  ].filter(Boolean).join('｜');
  const executeOutcome = pauseOutcomeCounts(stopped, notStopped)
    || color('comment', failedShops ? '已完成店铺中无符合暂停条件的推广' : '本次无符合暂停条件的推广');
  const title = payload.mode === 'execute' ? '# 千牛推广执行结果'
    : payload.mode === 'dry-run' ? '# 千牛推广巡检提醒' : '# 千牛推广巡检报告';
  const header = [
    title,
    `> 巡检完成 ${color('info', `${completed}/${config.profiles.length} 店`)}｜推广 ${payload.scanned} 个｜低 ROI ${color(payload.lowRoi.length ? 'warning' : 'info', `${payload.lowRoi.length} 个`)}`,
    payload.mode === 'execute'
      ? `> ${executeOutcome}`
      : payload.mode === 'dry-run'
        ? `> ${color('comment', '本次仅巡检，未执行暂停')}｜建议暂停 ${color('warning', `${payload.toClose.length} 个`)}`
        : `> ${color('comment', '本次仅生成本地报告，未执行暂停')}`,
    failedShops ? `> ${color('warning', `巡检未完成 ${failedShops} 店，请人工检查`)}` : '',
  ].filter(Boolean).join('\n');

  const sections = config.profiles.map(identity => {
    const heading = `## ${compactText(identity.browserUser, 40)}`;
    if (!payload.shops.find(shop => shop.profile === identity.profile)?.ok) {
      return {
        heading,
        summary: `> ${color('warning', '本店巡检未完成')}`,
        groups: [{ heading: '### 巡检结果', lines: [`- ${color('warning', '请人工检查店铺登录及页面状态')}`] }],
      };
    }

    const lowRows = payload.lowRoi.filter(row => row.profile === identity.profile);
    const closeRows = payload.toClose.filter(row => row.profile === identity.profile);
    const closeKeys = new Set(closeRows.map(keyOf));
    const groups = [];
    if (payload.mode === 'execute' && closeRows.length) {
      groups.push({
        heading: '### 暂停结果',
        lines: closeRows.map(row => verified.has(keyOf(row))
          ? pauseLine(displayRow(row), '推广已暂停', 'info')
          : pauseLine(displayRow(row), '推广未暂停', 'warning')),
      });
    } else if (payload.mode === 'dry-run' && closeRows.length) {
      groups.push({ heading: '### 建议处理', lines: closeRows.map(row => pauseLine(row, '建议暂停', 'warning')) });
    }
    const shownAsPause = payload.mode === 'execute' || payload.mode === 'dry-run' ? closeKeys : new Set();
    const otherLow = lowRows.filter(row => !shownAsPause.has(keyOf(row)));
    if (otherLow.length) {
      groups.push({ heading: closeRows.length && shownAsPause.size ? '### 其他低 ROI' : '### 低 ROI 推广', lines: otherLow.map(lowRoiLine) });
    } else if (!lowRows.length) {
      groups.push({ heading: '### 巡检结果', lines: [`- ${color('info', '暂无低 ROI 推广')}`] });
    }

    const shopStopped = closeRows.filter(row => verified.has(keyOf(row))).length;
    const shopOutcome = pauseOutcomeCounts(shopStopped, closeRows.length - shopStopped);
    const shopSummary = payload.mode === 'execute'
      ? `> 低 ROI ${color(lowRows.length ? 'warning' : 'info', `${lowRows.length} 个`)}${shopOutcome ? `｜${shopOutcome}` : ''}`
      : payload.mode === 'dry-run'
        ? `> 低 ROI ${color(lowRows.length ? 'warning' : 'info', `${lowRows.length} 个`)}｜建议暂停 ${color('warning', `${closeRows.length} 个`)}`
        : `> 低 ROI ${color(lowRows.length ? 'warning' : 'info', `${lowRows.length} 个`)}`;
    return { heading, summary: shopSummary, groups };
  });
  return splitShopMessages(header, sections);
}

async function sendWeChat(webhook, content) {
  const response = await fetch(webhook, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if ((await response.json()).errcode !== 0) throw new Error('WeCom rejected the notification');
}

// Dependencies are injectable solely for offline verification; the CLI always uses the actual OpenCLI launcher.
export async function run(options, dependencies = {}) {
  const env = dependencies.env || process.env;
  let config;
  try { config = JSON.parse(fs.readFileSync(options.configPath, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid JSON in config file');
    throw new Error(`Cannot read config file (${error.code || 'read error'})`);
  }
  config = validateConfig(config);
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
  const results = [], failures = [], closeResults = [], pauseReadbacks = [], shops = [], seen = new Set();
  const checkpoint = current => atomicJson(checkpointPath,
    { runId, mode: options.mode, current, results, shops, failures, closeResults, pauseReadbacks });
  const lifecycle = ['-f', 'json', '--window', 'background', '--site-session', 'ephemeral', '--keep-tab', 'false'];
  const pagination = ['--page-size', String(config.limits.pageSize), '--max-pages', String(config.limits.maxPages)];

  for (const [index, identity] of config.profiles.entries()) {
    log(`[${index + 1}/${config.profiles.length}] ${identity.browserUser}: scan`);
    checkpoint({ type: 'scan', profile: identity.profile });
    let rows, lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        rows = validateScan(await callOpencli(['--profile', identity.profile, 'alimama', 'scan-campaigns', ...pagination, ...lifecycle]), identity);
        break;
      } catch (error) { lastError = error; }
    }
    shops.push({ profile: identity.profile, browserUser: identity.browserUser, ok: !!rows });
    if (!rows) failures.push({ profile: identity.profile, browserUser: identity.browserUser, type: 'scan', message: lastError.message });
    else for (const row of rows) if (!seen.has(keyOf(row))) { seen.add(keyOf(row)); results.push(row); }
    checkpoint({ type: 'scan', profile: identity.profile, done: true });
  }

  const { lowRoi, toClose } = selectCampaigns(results, config.thresholds);
  if (options.mode === 'execute') for (const row of toClose) {
    const identity = config.profiles.find(item => item.profile === row.profile);
    // Persist intent before a write. An interrupted / uncertain write must be read back before any retry.
    checkpoint({ type: 'pause', profile: row.profile, promotionType: row.promotionType, campaignId: row.campaignId, status: 'pending' });
    try {
      const raw = await callOpencli(['--profile', row.profile, 'alimama', 'pause-campaign',
        '--promotion-type', row.promotionType === '关键词推广' ? 'keyword' : 'all-site',
        '--campaign-id', row.campaignId, '--expected-shop', identity.expectedAlimamaShop,
        '--expected-name', row.campaignName, '--max-roi', String(config.thresholds.closeRoiBelow),
        '--min-charge', String(config.thresholds.closeChargeAbove), ...pagination,
        '--execute', '--trace', 'retain-on-failure', ...lifecycle]);
      const result = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
      if (result?.ok !== true || result.verified !== true || result.shopName !== identity.expectedAlimamaShop
        || result.promotionType !== row.promotionType || String(result.campaignId) !== row.campaignId
        || result.campaignName !== row.campaignName || result.writeAttempted !== true
        || !['pause', 'not-in-active-list'].includes(result.afterStatus)) {
        throw new Error('Pause result did not confirm the expected campaign');
      }
      const verified = { ...result, profile: row.profile, browserUser: row.browserUser };
      const nextPaused = { ...state.paused, [keyOf(row)]: { at: new Date().toISOString(), runId, result: verified } };
      atomicJson(statePath, { ...state, paused: nextPaused });
      state.paused = nextPaused;
      closeResults.push(verified);
    } catch (error) {
      failures.push({ profile: row.profile, browserUser: row.browserUser, type: 'pause', campaignId: row.campaignId, message: error.message });
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
      const readback = {
        profile,
        browserUser: identity.browserUser,
        expectedAlimamaShop: identity.expectedAlimamaShop,
        ok: false,
        campaigns: [],
      };
      log(`${identity.browserUser}: final pause read-back`);
      checkpoint({ type: 'pause-readback', profile, status: 'pending' });
      try {
        // One complete read-only scan resolves every uncertain candidate in this shop. Never replay a pause write.
        const currentRows = validateScan(await callOpencli([
          '--profile', profile, 'alimama', 'scan-campaigns', ...pagination, ...lifecycle,
        ]), identity);
        readback.ok = true;
        readback.activeCampaignCount = currentRows.length;
        const nextPaused = { ...state.paused };
        const verifiedResults = [];
        for (const row of pending) {
          const sameId = currentRows.filter(current => current.campaignId === row.campaignId);
          const matches = currentRows.filter(current => keyOf(current) === keyOf(row));
          if (matches.length === 0) {
            if (sameId.length) {
              readback.campaigns.push({
                promotionType: row.promotionType,
                campaignId: row.campaignId,
                expectedCampaignName: row.campaignName,
                outcome: 'identity-mismatch',
                verified: false,
                current: null,
              });
              failures.push({
                profile,
                browserUser: identity.browserUser,
                type: 'pause-readback',
                campaignId: row.campaignId,
                message: 'Campaign promotion type changed during pause read-back',
              });
              continue;
            }
            const verifiedResult = {
              ...row,
              ok: true,
              verified: true,
              shopName: identity.expectedAlimamaShop,
              beforeStatus: 'unknown',
              afterStatus: 'not-in-active-list',
              writeAttempted: null,
              verificationSource: 'final-readback',
              message: 'verified inactive by complete final read-back',
            };
            nextPaused[keyOf(row)] = { at: new Date().toISOString(), runId, result: verifiedResult };
            verifiedResults.push(verifiedResult);
            readback.campaigns.push({
              promotionType: row.promotionType,
              campaignId: row.campaignId,
              expectedCampaignName: row.campaignName,
              outcome: 'inactive',
              verified: true,
              current: null,
            });
            continue;
          }

          const current = matches[0];
          const currentSnapshot = {
            campaignName: current.campaignName,
            roi: current.roi,
            charge: current.charge,
            displayStatus: current.displayStatus,
            onlineStatus: current.onlineStatus,
          };
          if (matches.length !== 1 || current.campaignName !== row.campaignName) {
            readback.campaigns.push({
              promotionType: row.promotionType,
              campaignId: row.campaignId,
              expectedCampaignName: row.campaignName,
              outcome: 'identity-mismatch',
              verified: false,
              current: currentSnapshot,
            });
            failures.push({
              profile,
              browserUser: identity.browserUser,
              type: 'pause-readback',
              campaignId: row.campaignId,
              message: matches.length !== 1
                ? 'Pause read-back returned duplicate campaign identities'
                : 'Campaign name changed during pause read-back',
            });
            continue;
          }
          readback.campaigns.push({
            promotionType: row.promotionType,
            campaignId: row.campaignId,
            expectedCampaignName: row.campaignName,
            outcome: 'active',
            verified: true,
            current: currentSnapshot,
          });
        }
        if (verifiedResults.length) {
          atomicJson(statePath, { ...state, paused: nextPaused });
          state.paused = nextPaused;
          closeResults.push(...verifiedResults);
        }
      } catch (error) {
        readback.error = error.message;
        readback.campaigns = pending.map(row => ({
          promotionType: row.promotionType,
          campaignId: row.campaignId,
          expectedCampaignName: row.campaignName,
          outcome: 'unverified',
          verified: false,
          current: null,
        }));
        failures.push({
          profile,
          browserUser: identity.browserUser,
          type: 'pause-readback',
          message: error.message,
        });
      }
      readback.checkedAt = new Date().toISOString();
      pauseReadbacks.push(readback);
      checkpoint({ type: 'pause-readback', profile, done: true });
    }
  }

  const payload = { runAt: new Date().toISOString(), runId, mode: options.mode, scanned: results.length,
    shops, lowRoi, toClose, closeResults, pauseReadbacks, failures,
    notification: { status: options.mode === 'report' ? 'disabled' : 'not-needed', sent: 0 } };
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('node runner.mjs [--mode report|dry-run|execute] [--config FILE] [--audit-dir DIR]\nDefault: report (local results only; no notification or pause).');
    else {
      const payload = await run(options);
      console.log(JSON.stringify(payload, null, 2));
      if (payload.failures.length) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

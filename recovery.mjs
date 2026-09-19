import fs from 'node:fs';
import path from 'node:path';
import { active, atomicJson, commandTimeoutArgs, createOpencli, keyOf, selectCampaigns, sendWeChat,
  targetArgs, targetGroups, validateConfig, validateScan, validateVerification, isAuthenticationError } from './runner.mjs';
import { buildMessages } from './messages.mjs';

const lifecycle = ['-f', 'json', '--window', 'background', '--site-session', 'ephemeral', '--keep-tab', 'false'];
const stamp = () => new Date().toISOString();
const stopped = row => row?.verified === true && ['pause', 'not-in-active-list'].includes(row.afterStatus);

export function latestOutcome(payload, row) {
  let latest, latestTime;
  for (const readback of payload.pauseReadbacks || []) {
    if (readback.profile !== row.profile) continue;
    const result = readback.campaigns?.find(item => item.campaignId === row.campaignId && item.promotionType === row.promotionType);
    if (result) {
      const time = Date.parse(readback.checkedAt);
      if (Number.isFinite(latestTime) && Number.isFinite(time) && time < latestTime) continue;
      const matches = (!result.expectedCampaignName || result.expectedCampaignName === row.campaignName)
        && (!result.current?.campaignName || result.current.campaignName === row.campaignName);
      latest = readback.ok && result.verified === true && matches ? result : { ...result, outcome: 'unverified' };
      latestTime = time;
    }
  }
  if (latest) return latest;
  return payload.closeResults?.some(result => keyOf(result) === keyOf(row) && stopped(result))
    ? { outcome: 'inactive', verified: true } : { outcome: 'unverified', verified: false };
}

export function unresolvedItems(payload, config) {
  const unresolved = payload.shops.filter(shop => !shop.ok).map(shop => ({ profile: shop.profile, type: 'scan' }));
  if (payload.mode !== 'execute') return unresolved;
  for (const row of payload.toClose) {
    const latest = latestOutcome(payload, row);
    if (latest.outcome === 'inactive') continue;
    if (latest.outcome === 'active' && latest.current && Number.isFinite(latest.current.roi) && Number.isFinite(latest.current.charge)
        && !selectCampaigns([{ ...row, ...latest.current }], config.thresholds).toClose.length) continue;
    unresolved.push({ profile: row.profile, promotionType: row.promotionType, campaignId: row.campaignId, type: latest.outcome });
  }
  return unresolved;
}

function historicalUnresolvedItems(payload, config, state) {
  return unresolvedItems(payload, config).filter(item => {
    if (item.type !== 'active') return true;
    const row = payload.toClose.find(candidate => candidate.profile === item.profile
      && candidate.promotionType === item.promotionType && candidate.campaignId === item.campaignId);
    return row && state.pending?.[keyOf(row)]?.runId === payload.runId;
  });
}

function readAudit(options, currentConfig) {
  const runId = options.recover || options.finalize;
  if (!/^[\w-]+$/.test(runId || '')) throw new Error('Invalid audit run ID');
  const file = path.join(options.auditDir, `${runId}.json`);
  const partial = path.join(options.auditDir, `${runId}.partial.json`);
  const source = fs.existsSync(file) ? file : partial;
  const payload = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (payload.runId !== runId || !['execute', 'dry-run'].includes(payload.mode)) throw new Error('Audit run identity or mode mismatch');
  const config = validateConfig(payload.configSnapshot || currentConfig);
  for (const identity of config.profiles) {
    const current = currentConfig.profiles.find(item => item.profile === identity.profile);
    if (!current || current.browserUser !== identity.browserUser || current.expectedAlimamaShop !== identity.expectedAlimamaShop) {
      throw new Error('Configured identity changed; agent must resolve it before recovery');
    }
  }
  if (!Array.isArray(payload.toClose)) {
    const selection = selectCampaigns(payload.results || [], config.thresholds);
    Object.assign(payload, selection, { scanned: (payload.results || []).length,
      notification: { status: 'awaiting-agent', sent: 0 } });
    for (const identity of config.profiles) {
      if (!payload.shops.some(shop => shop.profile === identity.profile)) payload.shops.push({ ...identity, ok: false });
    }
  }
  for (const name of ['closeResults', 'pauseReadbacks', 'pauseAttempts', 'failures']) payload[name] ||= [];
  payload.recovery ||= { status: 'awaiting-agent', rounds: 0 };
  payload.recovery.retryCounts ||= {};
  payload.configSnapshot ||= { profiles: config.profiles, allowedBrowserUsers: config.allowedBrowserUsers,
    thresholds: config.thresholds, limits: config.limits };
  return { payload, config, file, partial };
}

export async function recoverAudit(options, currentConfig, dependencies = {}) {
  const { payload, config, file, partial } = readAudit(options, currentConfig);
  const env = dependencies.env || process.env;
  const persist = () => atomicJson(file, payload);

  if (options.finalize) {
    if (payload.notification?.status === 'sent') {
      if (payload.recovery) {
        const statePath = path.join(options.auditDir, 'state.json');
        const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { pending: {} };
        state.pending ||= {};
        if (typeof state.pending !== 'object' || Array.isArray(state.pending)) throw new Error('Invalid recovery state file');
        payload.recovery.unresolved = historicalUnresolvedItems(payload, config, state);
        payload.recovery.status = payload.recovery.unresolved.length ? 'awaiting-agent' : 'resolved';
        persist();
      }
      return payload;
    }
    if (['sending', 'failed'].includes(payload.notification?.status)) {
      throw new Error('Previous notification may have been delivered; inspect before any resend');
    }
    if (!payload.recovery.checkedAt) throw new Error('Run --recover before finalizing an agent handoff');
    const webhook = env.WECHAT_WEBHOOK_URL;
    if (!webhook || new URL(webhook).protocol !== 'https:') throw new Error('WECHAT_WEBHOOK_URL must be an HTTPS URL');
    payload.recovery.unresolved = unresolvedItems(payload, config);
    payload.recovery.status = payload.recovery.unresolved.length ? 'finalized-with-pending' : 'resolved';
    payload.notification = { status: 'sending', sent: 0 };
    persist();
    const send = dependencies.send || sendWeChat;
    try {
      for (const content of buildMessages(payload, config)) {
        await send(webhook, content);
        payload.notification.sent++;
        persist();
      }
      payload.notification.status = 'sent';
    } catch {
      payload.notification.status = 'failed';
      payload.failures.push({ type: 'notification', message: 'Final notification failed; inspect saved delivery progress before any resend' });
    }
    persist();
    return payload;
  }

  // Recover reads are always safe to request. A second write requires the agent to have
  // positively established that the old page operation ended; an empty lease is insufficient.
  const settled = new Set((options.settledProfiles || '').split(',').filter(Boolean));
  if (options.retryPauses && !settled.size) throw new Error('Retry requires --settled-profiles after agent inspection of old operations');
  for (const profile of settled) {
    if (!config.profiles.some(identity => identity.profile === profile)) throw new Error('Unknown settled profile');
  }
  if (options.retryPauses && payload.mode !== 'execute') throw new Error('Only execute audits may retry pauses');
  if (['sending', 'failed'].includes(payload.notification?.status)) throw new Error('Resolve uncertain notification delivery before changing its audit');
  const alreadySent = payload.notification?.status === 'sent';
  if (alreadySent && options.retryPauses) throw new Error('Already-notified historical runs may only be read back, not replayed');
  const callOpencli = dependencies.callOpencli || createOpencli(env);
  const log = dependencies.log || (message => console.error(message));
  const pagination = ['--page-size', String(config.limits.pageSize), '--max-pages', String(config.limits.maxPages)];
  const commandTimeout = commandTimeoutArgs(env);
  const statePath = path.join(options.auditDir, 'state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { paused: {}, pending: {} };
  state.paused ||= {};
  state.pending ||= {};
  if (typeof state.paused !== 'object' || Array.isArray(state.paused)
      || typeof state.pending !== 'object' || Array.isArray(state.pending)) throw new Error('Invalid recovery state file');
  const foreignPendingKeys = new Set(Object.entries(state.pending)
    .filter(([, item]) => item.runId !== payload.runId).map(([key]) => key));
  const authBlockedProfiles = new Set();
  const saveState = () => { if (payload.mode === 'execute') atomicJson(statePath, state); };
  payload.recovery.rounds = (payload.recovery.rounds || 0) + 1;
  payload.recovery.status = 'recovering';
  delete payload.recovery.checkedAt;
  if (!alreadySent) payload.notification = { status: 'awaiting-agent', sent: 0 };
  persist();

  async function scan(identity, targets) {
    let lastError;
    for (let attempt = 1; attempt <= Math.min(config.limits.retries, 2); attempt++) {
      const startedAt = stamp();
      try {
        const raw = await callOpencli(['--profile', identity.profile, 'alimama', 'scan-campaigns',
          ...(targets ? targetArgs(targets) : []), ...pagination, ...commandTimeout,
          '--trace', 'retain-on-failure', ...lifecycle]);
        const rows = targets ? validateVerification(raw, identity, targets) : validateScan(raw, identity);
        (payload.recovery.scans ||= []).push({ profile: identity.profile,
          ...(targets ? { promotionType: targets[0].promotionType } : {}), startedAt, finishedAt: stamp(), ok: true });
        persist();
        return rows;
      } catch (error) {
        lastError = error;
        (payload.recovery.scans ||= []).push({ profile: identity.profile,
          ...(targets ? { promotionType: targets[0].promotionType } : {}), startedAt, finishedAt: stamp(), ok: false });
        persist();
        if (isAuthenticationError(error)) break;
      }
    }
    throw lastError;
  }

  function reconcile(identity, candidates, rows, error) {
    const readback = { profile: identity.profile, browserUser: identity.browserUser,
      ...(candidates.length ? { promotionType: candidates[0].promotionType } : {}),
      expectedAlimamaShop: identity.expectedAlimamaShop, ok: !error, checkedAt: stamp(), campaigns: [] };
    if (error) readback.error = error.message;
    for (const row of candidates) {
      const key = keyOf(row);
      const matches = rows?.filter(item => keyOf(item) === key) || [];
      let outcome = 'unverified', current = null;
      if (!error) {
        if (matches.length !== 1) outcome = 'unverified';
        else if (matches[0].campaignName !== row.campaignName) outcome = 'identity-mismatch';
        else {
          current = matches[0];
          outcome = current.recordType === 'verification' ? current.outcome : active(current) ? 'active' : 'unverified';
        }
      }
      payload.closeResults = payload.closeResults.filter(item => keyOf(item) !== key);
      const verified = ['inactive', 'active'].includes(outcome);
      readback.campaigns.push({ campaignId: row.campaignId, promotionType: row.promotionType,
        expectedCampaignName: row.campaignName, outcome, verified, current });
      if (outcome === 'inactive') {
        const result = { ...row, ok: true, verified: true, afterStatus: 'pause',
          writeAttempted: null, verificationSource: 'final-readback', checkedAt: readback.checkedAt };
        payload.closeResults.push(result);
        state.paused[key] = { at: readback.checkedAt, runId: payload.runId, result };
        delete state.pending[key];
      } else {
        delete state.paused[key];
        if (outcome === 'active' && Number.isFinite(current.roi) && Number.isFinite(current.charge)
            && !selectCampaigns([current], config.thresholds).toClose.length) delete state.pending[key];
        else if (alreadySent && settled.has(identity.profile) && outcome === 'active'
            && state.pending[key]?.runId === payload.runId) {
          // The old attempt is demonstrably over and the current status is explicit.
          // Release its write gate; a later authorized run must build its own fresh action list.
          delete state.pending[key];
          (payload.recovery.released ||= []).push({ key, at: stamp(), outcome });
        }
        else if (!alreadySent && !foreignPendingKeys.has(key)
          && (!state.pending[key] || state.pending[key].runId === payload.runId)) {
          state.pending[key] = { ...row, runId: payload.runId, status: outcome };
        }
      }
    }
    if (error) payload.failures.push({ profile: identity.profile, browserUser: identity.browserUser,
      type: 'pause-readback', ...(isAuthenticationError(error) ? { reason: 'auth-required', retryable: false } : {}),
      message: error.message, at: readback.checkedAt });
    payload.pauseReadbacks.push(readback);
    // Audit first: a crash cannot leave an old success looking like the latest read-back.
    persist();
    saveState();
  }

  async function verifyGroups(identity, candidates) {
    for (const group of targetGroups(candidates)) {
      try { reconcile(identity, group, await scan(identity, group)); }
      catch (error) {
        reconcile(identity, group, null, error);
        if (isAuthenticationError(error)) {
          authBlockedProfiles.add(identity.profile);
          break;
        }
      }
    }
  }

  for (const identity of config.profiles) {
    let shop = payload.shops.find(item => item.profile === identity.profile);
    if (!shop) { shop = { profile: identity.profile, browserUser: identity.browserUser, ok: false }; payload.shops.push(shop); }
    let candidates = payload.toClose.filter(row => row.profile === identity.profile);
    if (shop.ok && !candidates.length) continue;
    log(`${identity.browserUser}: agent recovery read-back`);
    if (shop.ok) {
      await verifyGroups(identity, candidates);
    } else {
      let rows;
      try { rows = await scan(identity); }
      catch (error) {
        if (isAuthenticationError(error)) authBlockedProfiles.add(identity.profile);
        payload.failures.push({ profile: identity.profile, type: 'scan', message: error.message, at: stamp() });
        reconcile(identity, candidates, null, error);
        continue;
      }
      shop.ok = true;
      payload.scanned += rows.length;
      const selection = selectCampaigns(rows, config.thresholds);
      payload.lowRoi = [...payload.lowRoi.filter(row => row.profile !== identity.profile), ...selection.lowRoi];
      const existing = new Set(payload.toClose.map(keyOf));
      payload.toClose.push(...selection.toClose.filter(row => !existing.has(keyOf(row))));
      candidates = payload.toClose.filter(row => row.profile === identity.profile);
      reconcile(identity, candidates, rows);
    }
    if (!options.retryPauses || !settled.has(identity.profile) || authBlockedProfiles.has(identity.profile)) continue;
    let attempted = false;
    for (const row of candidates) {
      const key = keyOf(row);
      const latest = latestOutcome(payload, row);
      if (latest.outcome !== 'active' || !selectCampaigns([latest.current], config.thresholds).toClose.length) continue;
      if (payload.recovery.retryCounts[key]) continue;
      const foreignPending = Object.entries(state.pending)
        .find(([pendingKey, item]) => pendingKey === key && item.runId !== payload.runId);
      if (foreignPending) { payload.recovery.blockedByRun = foreignPending.runId; persist(); continue; }
      // Persist budget and intent before the call. A crash never grants another retry.
      payload.recovery.retryCounts[key] = 1;
      payload.pauseAttempts.push({ ...row, status: 'pending', recovery: true, at: stamp(), agentConfirmedSettled: true });
      state.pending[key] = { ...row, runId: payload.runId, status: 'pending', recoveryAttempted: true };
      persist(); saveState();
      attempted = true;
      try {
        const raw = await callOpencli(['--profile', row.profile, 'alimama', 'pause-campaign',
          '--promotion-type', row.promotionType === '关键词推广' ? 'keyword' : 'all-site',
          '--campaign-id', row.campaignId, '--expected-shop', identity.expectedAlimamaShop,
          '--expected-name', row.campaignName, '--max-roi', String(config.thresholds.closeRoiBelow),
          '--min-charge', String(config.thresholds.closeChargeAbove), ...pagination,
          ...commandTimeout, '--execute', '--trace', 'retain-on-failure', ...lifecycle.map((value, index) => lifecycle[index - 1] === '--site-session' ? 'persistent' : value)]);
        const result = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
        if (result?.ok !== true || !stopped(result) || result.writeAttempted !== true
            || result.shopName !== identity.expectedAlimamaShop || result.campaignName !== row.campaignName
            || String(result.campaignId) !== row.campaignId || result.promotionType !== row.promotionType) {
          throw new Error('Recovery pause did not confirm the expected campaign');
        }
        payload.pauseAttempts.at(-1).status = 'verified';
      } catch (error) {
        payload.pauseAttempts.at(-1).status = 'uncertain';
        if (isAuthenticationError(error)) authBlockedProfiles.add(identity.profile);
        payload.failures.push({ profile: row.profile, type: 'pause', campaignId: row.campaignId,
          ...(isAuthenticationError(error) ? { reason: 'auth-required', retryable: false } : {}), message: error.message, at: stamp() });
        persist();
        break; // Other shops continue; this shop gets a read-only check, never another blind write.
      }
      persist();
    }
    if (attempted && !authBlockedProfiles.has(identity.profile)) await verifyGroups(identity, candidates);
  }
  payload.recovery.checkedAt = stamp();
  payload.recovery.unresolved = alreadySent
    ? historicalUnresolvedItems(payload, config, state)
    : unresolvedItems(payload, config);
  payload.recovery.status = payload.recovery.unresolved.length
    ? 'awaiting-agent'
    : alreadySent ? 'resolved' : 'ready-to-finalize';
  payload.runAt = stamp();
  persist();
  if (fs.existsSync(partial)) fs.renameSync(partial, path.join(options.auditDir, `${payload.runId}.recovered-checkpoint.json`));
  return payload;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../runner.mjs';
import { latestOutcome } from '../recovery.mjs';

const thresholds = { notifyRoiBelow: 2, closeChargeAbove: 30, closeRoiBelow: 1.5 };
const identities = [
  { profile: 'alpha', browserUser: '示例甲', expectedAlimamaShop: '页面甲' },
  { profile: 'beta', browserUser: '示例乙', expectedAlimamaShop: '页面乙' },
];
const envWithWebhook = { WECHAT_WEBHOOK_URL: 'https://example.invalid/never-contacted' };
const option = (args, name) => args[args.indexOf(name) + 1];
const optionalOption = (args, name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const keyOf = row => `${row.profile}|${row.promotionType}|${row.campaignId}`;

function configFor(profiles = identities) {
  return { profiles, allowedBrowserUsers: profiles.map(row => row.browserUser), thresholds,
    limits: { retries: 2, pageSize: 500, maxPages: 50 } };
}

function campaign(identity, campaignId = 'plan-a', overrides = {}) {
  return { recordType: 'campaign', profile: identity.profile, browserUser: identity.browserUser,
    shopName: identity.expectedAlimamaShop, campaignId, campaignName: `计划 ${campaignId}`,
    promotionType: '全站推', roi: 1, charge: 40, displayStatus: 'start', onlineStatus: 1, ...overrides };
}

function scanResult(identity, rows = [campaign(identity)]) {
  return [{ recordType: 'identity', shopName: identity.expectedAlimamaShop },
    ...rows.map(row => {
      const { profile: _profile, browserUser: _browserUser, ...result } = row;
      return { ...result, shopName: identity.expectedAlimamaShop };
    })];
}

function targetsFrom(args) {
  const raw = optionalOption(args, '--targets');
  return raw === undefined ? undefined : JSON.parse(raw);
}

function verification(identity, target, outcome = 'active', overrides = {}) {
  const status = outcome === 'inactive'
    ? { displayStatus: 'pause', onlineStatus: 0 }
    : outcome === 'active'
      ? { displayStatus: 'start', onlineStatus: 1 }
      : { displayStatus: null, onlineStatus: null };
  return {
    recordType: 'verification', shopName: identity.expectedAlimamaShop,
    promotionType: target.promotionType, campaignId: target.campaignId, campaignName: target.campaignName,
    outcome, verified: outcome === 'active' || outcome === 'inactive', roi: 1, charge: 40,
    ...status, ...overrides,
  };
}

function verificationResult(identity, targets, outcome = 'active', overrides = {}) {
  return [{ recordType: 'identity', shopName: identity.expectedAlimamaShop },
    ...targets.map((target, index) => {
      const value = typeof outcome === 'function' ? outcome(target, index) : outcome;
      return verification(identity, target, typeof value === 'string' ? value : value.outcome,
        typeof value === 'string' ? overrides : value);
    })];
}

function verified(row, overrides = {}) {
  return { ...row, ok: true, verified: true, writeAttempted: true, afterStatus: 'pause', ...overrides };
}

function setup(t, profiles = [identities[0]]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qianniu-recovery-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = configFor(profiles);
  const configPath = path.join(dir, 'config.json');
  const auditDir = path.join(dir, 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { config, configPath, auditDir, options: { mode: 'execute', configPath, auditDir } };
}

function auditFor(runId, config, candidates, overrides = {}) {
  return {
    runAt: '2026-09-16T00:00:00.000Z', runId, mode: 'execute', configSnapshot: config,
    scanned: candidates.length,
    shops: config.profiles.map(identity => ({ profile: identity.profile, browserUser: identity.browserUser, ok: true })),
    lowRoi: candidates, toClose: candidates, closeResults: [], pauseReadbacks: [], pauseAttempts: [], failures: [],
    notification: { status: 'awaiting-agent', sent: 0 },
    recovery: { status: 'awaiting-agent', rounds: 0, unresolved: [] },
    ...overrides,
  };
}

function seedAudit(context, payload, { partial = false, state } = {}) {
  const suffix = partial ? '.partial.json' : '.json';
  fs.writeFileSync(path.join(context.auditDir, `${payload.runId}${suffix}`), JSON.stringify(payload));
  if (state) fs.writeFileSync(path.join(context.auditDir, 'state.json'), JSON.stringify(state));
}

test('initial execute isolates an uncertain shop, continues other shops, and defers notification', async t => {
  const context = setup(t, identities);
  const alphaRows = [campaign(identities[0], 'alpha-first'), campaign(identities[0], 'alpha-second')];
  const betaRows = [campaign(identities[1], 'beta-first')];
  const calls = [], notifications = [];

  const result = await run(context.options, {
    env: envWithWebhook, log() {}, send(_url, content) { notifications.push(content); },
    callOpencli(args) {
      const profile = option(args, '--profile');
      const command = args[3];
      const id = optionalOption(args, '--campaign-id');
      calls.push(`${command}:${profile}${id ? `:${id}` : ''}`);
      if (command === 'scan-campaigns') {
        const targets = targetsFrom(args);
        if (targets) return verificationResult(identities[0], targets, 'active');
        if (profile === 'alpha') return scanResult(identities[0], alphaRows);
        return scanResult(identities[1], betaRows);
      }
      if (profile === 'alpha' && id === 'alpha-first') throw new Error('OpenCLI exited with status 75');
      if (profile === 'alpha' && id === 'alpha-second') return verified(alphaRows[1]);
      return verified(betaRows[0]);
    },
  });

  assert.deepEqual(calls, [
    'scan-campaigns:alpha', 'scan-campaigns:beta',
    'pause-campaign:alpha:alpha-first', 'pause-campaign:alpha:alpha-second', 'pause-campaign:beta:beta-first',
    'scan-campaigns:alpha',
  ]);
  assert.equal(result.toClose.length, 3);
  assert.deepEqual(result.pauseAttempts.map(row => [row.profile, row.campaignId, row.status]), [
    ['alpha', 'alpha-first', 'uncertain'], ['alpha', 'alpha-second', 'verified'], ['beta', 'beta-first', 'verified'],
  ]);
  assert.deepEqual(result.closeResults.map(row => row.campaignId), ['alpha-second', 'beta-first']);
  assert.equal(result.notification.status, 'awaiting-agent');
  assert.equal(result.recovery.status, 'awaiting-agent');
  assert.equal(notifications.length, 0);
});

test('runner target read-back requests only pause candidates and excludes unrelated promotion types', async t => {
  const context = setup(t);
  const candidate = campaign(identities[0], 'target-all-site');
  const unrelatedKeyword = campaign(identities[0], 'other-keyword', {
    campaignName: '无需暂停的关键词计划', promotionType: '关键词推广', roi: 1.8, charge: 80,
  });
  const calls = [];

  const result = await run(context.options, {
    env: envWithWebhook, log() {}, send() { assert.fail('unresolved execution must not notify'); },
    callOpencli(args) {
      calls.push(args);
      if (args[3] === 'pause-campaign') throw new Error('OpenCLI exited with status 75');
      const targets = targetsFrom(args);
      if (!targets) return scanResult(identities[0], [candidate, unrelatedKeyword]);
      assert.deepEqual(targets, [{ promotionType: '全站推', campaignId: candidate.campaignId,
        campaignName: candidate.campaignName }]);
      assert.ok(targets.every(target => target.promotionType !== '关键词推广'));
      return verificationResult(identities[0], targets, 'active');
    },
  });

  const targetCalls = calls.filter(args => targetsFrom(args));
  assert.equal(targetCalls.length, 1);
  assert.equal(targetCalls[0][3], 'scan-campaigns');
  assert.equal(result.toClose.length, 1);
  assert.equal(result.toClose[0].campaignId, candidate.campaignId);
  assert.equal(result.pauseReadbacks[0].campaigns.length, 1);
  assert.equal(result.pauseReadbacks[0].campaigns[0].campaignId, candidate.campaignId);
  assert.equal(result.notification.status, 'awaiting-agent');
});

test('recovery verifies promotion types independently and preserves a successful group', async t => {
  const context = setup(t);
  const allSite = campaign(identities[0], 'all-site');
  const keyword = campaign(identities[0], 'keyword', { promotionType: '关键词推广' });
  const runId = 'split-target-groups';
  seedAudit(context, auditFor(runId, context.config, [allSite, keyword]));
  const calls = [];

  const result = await run({ ...context.options, recover: runId }, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      const targets = targetsFrom(args);
      calls.push(targets.map(target => target.promotionType));
      if (targets[0].promotionType === '关键词推广') throw new Error('keyword route stalled');
      return verificationResult(identities[0], targets, 'active');
    },
  });

  assert.deepEqual(calls, [['全站推'], ['关键词推广'], ['关键词推广']]);
  assert.equal(result.pauseReadbacks.length, 2);
  assert.equal(result.pauseReadbacks.find(row => row.promotionType === '全站推').campaigns[0].outcome, 'active');
  assert.equal(result.pauseReadbacks.find(row => row.promotionType === '关键词推广').campaigns[0].outcome, 'unverified');
  assert.equal(result.recovery.status, 'awaiting-agent');
});

test('recovery does not retry a profile after its login session is lost', async t => {
  const context = setup(t);
  const runId = 'recovery-login-required';
  const row = campaign(identities[0]);
  seedAudit(context, auditFor(runId, context.config, [row]), {
    state: { paused: {}, pending: { [keyOf(row)]: { ...row, runId, status: 'pending' } } },
  });
  const calls = [];
  const result = await run({ ...context.options, recover: runId, retryPauses: true, settledProfiles: 'alpha' }, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      calls.push(args[3]);
      throw new Error('Authentication required: Alimama login page is active');
    },
  });
  assert.deepEqual(calls, ['scan-campaigns']);
  assert.equal(result.pauseAttempts.length, 0);
  assert.equal(result.pauseReadbacks.length, 1);
  assert.equal(result.pauseReadbacks[0].campaigns[0].outcome, 'unverified');
  assert.equal(result.failures[0].reason, 'auth-required');
  assert.equal(result.recovery.status, 'awaiting-agent');
});

test('recovery proves a timed-out pause inactive and never replays its write', async t => {
  const context = setup(t);
  const runId = 'timeout-already-stopped';
  const row = campaign(identities[0]);
  seedAudit(context, auditFor(runId, context.config, [row], {
    failures: [{ profile: 'alpha', type: 'pause', campaignId: row.campaignId, message: 'status 75' }],
  }), { state: { paused: {}, pending: { [keyOf(row)]: { ...row, runId, status: 'pending' } } } });
  const calls = [];

  const result = await run({ ...context.options, recover: runId, retryPauses: true, settledProfiles: 'alpha' }, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      calls.push(args[3]);
      assert.equal(args[3], 'scan-campaigns');
      const targets = targetsFrom(args);
      assert.deepEqual(targets, [{ promotionType: row.promotionType, campaignId: row.campaignId,
        campaignName: row.campaignName }]);
      return verificationResult(identities[0], targets, 'inactive');
    },
  });

  assert.deepEqual(calls, ['scan-campaigns']);
  assert.equal(result.closeResults.length, 1);
  assert.equal(result.closeResults[0].verificationSource, 'final-readback');
  assert.equal(result.pauseReadbacks.at(-1).campaigns[0].outcome, 'inactive');
  assert.deepEqual(result.recovery.retryCounts, {});
  assert.equal(result.recovery.status, 'ready-to-finalize');
});

test('a missing target is explicitly unverified and never counted as paused', async t => {
  const context = setup(t);
  const runId = 'target-missing';
  const row = campaign(identities[0]);
  seedAudit(context, auditFor(runId, context.config, [row], { closeResults: [verified(row)] }));
  let scans = 0;

  const result = await run({ ...context.options, recover: runId }, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      scans++;
      const targets = targetsFrom(args);
      assert.deepEqual(targets, [{ promotionType: row.promotionType, campaignId: row.campaignId,
        campaignName: row.campaignName }]);
      return verificationResult(identities[0], targets, 'unverified');
    },
  });

  assert.equal(scans, 1);
  assert.equal(result.pauseReadbacks.at(-1).campaigns[0].outcome, 'unverified');
  assert.equal(result.pauseReadbacks.at(-1).campaigns[0].verified, false);
  assert.deepEqual(result.closeResults, []);
  assert.equal(result.recovery.status, 'awaiting-agent');
});

test('an eligible active campaign gets one recovery write and keeps its retry budget across rounds', async t => {
  const context = setup(t);
  const runId = 'one-retry-across-rounds';
  const row = campaign(identities[0]);
  seedAudit(context, auditFor(runId, context.config, [row]), {
    state: { paused: {}, pending: { [keyOf(row)]: { ...row, runId, status: 'pending' } } },
  });
  let scans = 0, pauses = 0;
  const dependencies = {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      if (args[3] === 'scan-campaigns') {
        scans++;
        return verificationResult(identities[0], targetsFrom(args), 'active');
      }
      pauses++;
      assert.equal(option(args, '--site-session'), 'persistent');
      assert.equal(option(args, '--expected-shop'), identities[0].expectedAlimamaShop);
      assert.equal(option(args, '--expected-name'), row.campaignName);
      assert.equal(option(args, '--max-roi'), '1.5');
      assert.equal(option(args, '--min-charge'), '30');
      throw new Error('OpenCLI exited with status 75');
    },
  };

  const first = await run({ ...context.options, recover: runId, retryPauses: true, settledProfiles: 'alpha' }, dependencies);
  assert.equal(pauses, 1);
  assert.equal(scans, 2);
  assert.equal(first.recovery.retryCounts[keyOf(row)], 1);
  assert.equal(first.pauseAttempts.at(-1).status, 'uncertain');
  assert.equal(first.recovery.status, 'awaiting-agent');

  const second = await run({ ...context.options, recover: runId, retryPauses: true, settledProfiles: 'alpha' }, dependencies);
  assert.equal(pauses, 1, 'the persisted retry budget must block a second write');
  assert.equal(scans, 3, 'a new recovery round still requires a fresh read-only scan');
  assert.equal(second.recovery.retryCounts[keyOf(row)], 1);
  assert.equal(second.recovery.rounds, 2);
});

test('fresh improved metrics resolve an active candidate without a recovery write', async t => {
  const context = setup(t);
  const runId = 'metrics-improved';
  const row = campaign(identities[0]);
  const improved = campaign(identities[0], row.campaignId, { roi: 1.75, charge: 90 });
  seedAudit(context, auditFor(runId, context.config, [row]), {
    state: { paused: {}, pending: { [keyOf(row)]: { ...row, runId, status: 'pending' } } },
  });
  const calls = [];

  const result = await run({ ...context.options, recover: runId, retryPauses: true, settledProfiles: 'alpha' }, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      calls.push(args[3]);
      assert.equal(args[3], 'scan-campaigns');
      return verificationResult(identities[0], targetsFrom(args), 'active', { roi: improved.roi, charge: improved.charge });
    },
  });

  assert.deepEqual(calls, ['scan-campaigns']);
  assert.equal(result.pauseReadbacks.at(-1).campaigns[0].outcome, 'active');
  assert.equal(result.pauseReadbacks.at(-1).campaigns[0].current.roi, 1.75);
  assert.equal(result.recovery.status, 'ready-to-finalize');
  assert.deepEqual(result.recovery.unresolved, []);
  const state = JSON.parse(fs.readFileSync(path.join(context.auditDir, 'state.json'), 'utf8'));
  assert.equal(state.pending[keyOf(row)], undefined);
});

test('a foreign pending owner survives recovery and blocks writes for that campaign', async t => {
  const context = setup(t);
  const runId = 'current-recovery-run';
  const foreignRunId = 'older-unresolved-run';
  const row = campaign(identities[0]);
  seedAudit(context, auditFor(runId, context.config, [row]), {
    state: { paused: {}, pending: { [keyOf(row)]: { ...row, runId: foreignRunId, status: 'pending' } } },
  });
  let scans = 0, pauses = 0;

  const result = await run({ ...context.options, recover: runId, retryPauses: true, settledProfiles: 'alpha' }, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      if (args[3] === 'scan-campaigns') {
        scans++;
        return verificationResult(identities[0], targetsFrom(args), 'active');
      }
      pauses++;
      return verified(row);
    },
  });

  assert.equal(scans, 1);
  assert.equal(pauses, 0);
  assert.equal(result.recovery.status, 'awaiting-agent');
  assert.deepEqual(result.recovery.retryCounts, {});
  const state = JSON.parse(fs.readFileSync(path.join(context.auditDir, 'state.json'), 'utf8'));
  assert.equal(state.pending[keyOf(row)].runId, foreignRunId);
  assert.equal(state.pending[keyOf(row)].status, 'pending');
});

test('a foreign pending campaign does not block another campaign in the same shop', async t => {
  const context = setup(t);
  const runId = 'current-recovery-run';
  const foreignRunId = 'older-unresolved-run';
  const blocked = campaign(identities[0], 'blocked');
  const eligible = campaign(identities[0], 'eligible');
  seedAudit(context, auditFor(runId, context.config, [blocked, eligible]), {
    state: { paused: {}, pending: { [keyOf(blocked)]: { ...blocked, runId: foreignRunId, status: 'pending' } } },
  });
  let pauses = 0;
  let paused = false;

  const result = await run({ ...context.options, recover: runId, retryPauses: true, settledProfiles: 'alpha' }, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      if (args[3] === 'scan-campaigns') {
        const targets = targetsFrom(args);
        return verificationResult(identities[0], targets, target =>
          target.campaignId === eligible.campaignId && paused ? 'inactive' : 'active');
      }
      pauses++;
      assert.equal(option(args, '--campaign-id'), eligible.campaignId);
      paused = true;
      return verified(eligible);
    },
  });

  assert.equal(pauses, 1);
  assert.equal(result.closeResults.some(row => row.campaignId === eligible.campaignId), true);
  const state = JSON.parse(fs.readFileSync(path.join(context.auditDir, 'state.json'), 'utf8'));
  assert.equal(state.pending[keyOf(blocked)].runId, foreignRunId);
  assert.equal(state.pending[keyOf(eligible)], undefined);
});

test('a newer run cannot claim an older run pending; recovering the owner remains possible', async t => {
  const context = setup(t);
  const ownerRunId = 'owner-run-a';
  const first = campaign(identities[0], 'plan-a');
  const second = campaign(identities[0], 'plan-b');
  seedAudit(context, auditFor(ownerRunId, context.config, [first]), {
    state: { paused: {}, pending: { [keyOf(first)]: { ...first, runId: ownerRunId, status: 'pending' } } },
  });
  let initialPauses = 0;

  const newer = await run(context.options, {
    env: envWithWebhook, log() {}, send() { assert.fail('an unresolved newer run must not notify'); },
    callOpencli(args) {
      if (args[3] === 'pause-campaign') {
        initialPauses++;
        return verified(option(args, '--campaign-id') === second.campaignId ? second : first);
      }
      const targets = targetsFrom(args);
      if (targets) return verificationResult(identities[0], targets, 'active');
      return scanResult(identities[0], [first, second]);
    },
  });
  assert.equal(initialPauses, 1);
  assert.equal(newer.notification.status, 'awaiting-agent');
  assert.ok(newer.recovery.unresolved.some(item => item.type === 'prior-run' && item.runId === ownerRunId));
  let state = JSON.parse(fs.readFileSync(path.join(context.auditDir, 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.pending), [keyOf(first)]);
  assert.equal(state.pending[keyOf(first)].runId, ownerRunId);

  let newerRecoveryPauses = 0;
  const recoveredNewer = await run({ ...context.options, recover: newer.runId,
    retryPauses: true, settledProfiles: 'alpha' }, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      if (args[3] === 'pause-campaign') { newerRecoveryPauses++; return verified(first); }
      const targets = targetsFrom(args);
      return verificationResult(identities[0], targets, target =>
        target.campaignId === second.campaignId ? 'inactive' : 'active');
    },
  });
  assert.equal(newerRecoveryPauses, 0);
  assert.equal(recoveredNewer.recovery.status, 'awaiting-agent');
  state = JSON.parse(fs.readFileSync(path.join(context.auditDir, 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.pending), [keyOf(first)]);
  assert.equal(state.pending[keyOf(first)].runId, ownerRunId);

  let ownerScans = 0, ownerPauses = 0;
  const recoveredOwner = await run({ ...context.options, recover: ownerRunId,
    retryPauses: true, settledProfiles: 'alpha' }, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      if (args[3] === 'scan-campaigns') {
        ownerScans++;
        return verificationResult(identities[0], targetsFrom(args), ownerScans === 1 ? 'active' : 'inactive');
      }
      ownerPauses++;
      return verified(first);
    },
  });
  assert.equal(ownerPauses, 1);
  assert.equal(recoveredOwner.closeResults.length, 1);
  assert.equal(recoveredOwner.recovery.status, 'ready-to-finalize');
  state = JSON.parse(fs.readFileSync(path.join(context.auditDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.pending, {});
});

test('an active campaign with missing metrics remains unresolved and is never retried', async t => {
  const context = setup(t);
  const runId = 'missing-current-metrics';
  const row = campaign(identities[0]);
  const incomplete = campaign(identities[0], row.campaignId, { roi: null, charge: 40 });
  seedAudit(context, auditFor(runId, context.config, [row]), {
    state: { paused: {}, pending: { [keyOf(row)]: { ...row, runId, status: 'pending' } } },
  });
  let pauses = 0;

  const result = await run({ ...context.options, recover: runId, retryPauses: true, settledProfiles: 'alpha' }, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      if (args[3] === 'scan-campaigns') {
        return verificationResult(identities[0], targetsFrom(args), 'active', { roi: null, charge: incomplete.charge });
      }
      pauses++;
      return verified(row);
    },
  });

  assert.equal(pauses, 0);
  assert.equal(result.pauseReadbacks.at(-1).campaigns[0].outcome, 'active');
  assert.equal(result.recovery.status, 'awaiting-agent');
  assert.deepEqual(result.recovery.unresolved.map(item => item.campaignId), [row.campaignId]);
  const state = JSON.parse(fs.readFileSync(path.join(context.auditDir, 'state.json'), 'utf8'));
  assert.equal(state.pending[keyOf(row)].runId, runId);
});

test('identity mismatch during recovery never reaches the pause adapter', async t => {
  const context = setup(t);
  const runId = 'identity-mismatch';
  const row = campaign(identities[0]);
  seedAudit(context, auditFor(runId, context.config, [row]));
  let scans = 0, pauses = 0;

  const result = await run({ ...context.options, recover: runId, retryPauses: true, settledProfiles: 'alpha' }, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      if (args[3] !== 'scan-campaigns') { pauses++; return verified(row); }
      scans++;
      return [{ recordType: 'identity', shopName: '错误店铺' },
        { ...verification(identities[0], targetsFrom(args)[0]), shopName: '错误店铺' }];
    },
  });

  assert.equal(scans, 2);
  assert.equal(pauses, 0);
  assert.equal(result.pauseReadbacks.at(-1).ok, false);
  assert.equal(result.pauseReadbacks.at(-1).campaigns[0].outcome, 'unverified');
  assert.equal(result.recovery.status, 'awaiting-agent');
});

test('latest active and unverified readbacks remove stale verified close results', async t => {
  await t.test('active', async t => {
    const context = setup(t);
    const runId = 'latest-active';
    const row = campaign(identities[0]);
    seedAudit(context, auditFor(runId, context.config, [row], { closeResults: [verified(row)] }));
    const result = await run({ ...context.options, recover: runId }, {
      env: envWithWebhook, log() {}, callOpencli(args) {
        return verificationResult(identities[0], targetsFrom(args), 'active');
      },
    });
    assert.equal(result.pauseReadbacks.at(-1).campaigns[0].outcome, 'active');
    assert.deepEqual(result.closeResults, []);
  });

  await t.test('unverified', async t => {
    const context = setup(t);
    const runId = 'latest-unverified';
    const row = campaign(identities[0]);
    seedAudit(context, auditFor(runId, context.config, [row], { closeResults: [verified(row)] }));
    let scans = 0;
    const result = await run({ ...context.options, recover: runId }, {
      env: envWithWebhook, log() {}, callOpencli() { scans++; throw new Error('read-back timeout'); },
    });
    assert.equal(scans, 2);
    assert.equal(result.pauseReadbacks.at(-1).campaigns[0].outcome, 'unverified');
    assert.deepEqual(result.closeResults, []);
  });
});

test('latest outcome uses checkedAt order and requires expected and current names to match', () => {
  const row = campaign(identities[0]);
  const activeResult = { promotionType: row.promotionType, campaignId: row.campaignId,
    expectedCampaignName: row.campaignName, outcome: 'active', verified: true, current: row };
  const inactiveResult = { promotionType: row.promotionType, campaignId: row.campaignId,
    expectedCampaignName: row.campaignName, outcome: 'inactive', verified: true, current: null };
  const payload = auditFor('ordered-readbacks', configFor([identities[0]]), [row], {
    pauseReadbacks: [
      { profile: row.profile, ok: true, checkedAt: '2026-09-16T02:00:00.000Z', campaigns: [activeResult] },
      { profile: row.profile, ok: true, checkedAt: '2026-09-16T01:00:00.000Z', campaigns: [inactiveResult] },
    ],
  });

  assert.equal(latestOutcome(payload, row).outcome, 'active', 'array order must not override a newer timestamp');
  payload.pauseReadbacks.push({ profile: row.profile, ok: true, checkedAt: '2026-09-16T03:00:00.000Z',
    campaigns: [{ ...inactiveResult, expectedCampaignName: '别的计划' }] });
  assert.equal(latestOutcome(payload, row).outcome, 'unverified');
  payload.pauseReadbacks.push({ profile: row.profile, ok: true, checkedAt: '2026-09-16T04:00:00.000Z',
    campaigns: [{ ...activeResult, current: { ...row, campaignName: '另一个计划' } }] });
  assert.equal(latestOutcome(payload, row).outcome, 'unverified');
});

test('read-only recovery of a historically sent audit never creates a new pending lock', async t => {
  const context = setup(t);
  const runId = 'already-notified-history';
  const row = campaign(identities[0]);
  seedAudit(context, auditFor(runId, context.config, [row], {
    notification: { status: 'sent', sent: 2 },
    recovery: { status: 'resolved', rounds: 1, checkedAt: '2026-09-16T00:00:00.000Z', unresolved: [] },
  }), { state: { paused: {}, pending: {} } });
  let sends = 0;

  const result = await run({ ...context.options, recover: runId }, {
    env: envWithWebhook, log() {}, send() { sends++; },
    callOpencli(args) { return verificationResult(identities[0], targetsFrom(args), 'active'); },
  });

  assert.equal(sends, 0);
  assert.equal(result.notification.status, 'sent');
  assert.equal(result.recovery.status, 'resolved');
  assert.deepEqual(result.recovery.unresolved, []);
  assert.equal(result.pauseReadbacks.at(-1).campaigns[0].outcome, 'active');
  const state = JSON.parse(fs.readFileSync(path.join(context.auditDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.pending, {});
});

test('settled read-only recovery releases only explicit active locks from a historically sent run', async t => {
  const context = setup(t);
  const runId = 'settled-notified-history';
  const activeLock = campaign(identities[0], 'active-lock');
  const unknownLock = campaign(identities[0], 'unknown-lock');
  const neverLocked = campaign(identities[0], 'never-locked');
  seedAudit(context, auditFor(runId, context.config, [activeLock, unknownLock, neverLocked], {
    notification: { status: 'sent', sent: 2 },
    recovery: { status: 'resolved', rounds: 1, checkedAt: '2026-09-16T00:00:00.000Z', unresolved: [] },
  }), { state: { paused: {}, pending: {
    [keyOf(activeLock)]: { ...activeLock, runId, status: 'pending' },
    [keyOf(unknownLock)]: { ...unknownLock, runId, status: 'pending' },
  } } });
  let scans = 0, pauses = 0, sends = 0;
  const dependencies = {
    env: envWithWebhook, log() {}, send() { sends++; },
    callOpencli(args) {
      if (args[3] === 'pause-campaign') { pauses++; return verified(activeLock); }
      scans++;
      const targets = targetsFrom(args);
      return verificationResult(identities[0], targets, scans === 1 ? 'active' : target =>
        target.campaignId === unknownLock.campaignId ? 'unverified' : 'active');
    },
  };

  const readonly = await run({ ...context.options, recover: runId }, dependencies);
  assert.equal(readonly.notification.status, 'sent');
  let state = JSON.parse(fs.readFileSync(path.join(context.auditDir, 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.pending).sort(), [keyOf(activeLock), keyOf(unknownLock)].sort());

  const settled = await run({ ...context.options, recover: runId, settledProfiles: 'alpha' }, dependencies);
  assert.equal(scans, 2);
  assert.equal(pauses, 0);
  assert.equal(sends, 0);
  assert.equal(settled.notification.status, 'sent');
  assert.equal(settled.recovery.status, 'awaiting-agent');
  assert.deepEqual(settled.recovery.unresolved.map(item => item.campaignId), [unknownLock.campaignId]);
  assert.deepEqual(settled.recovery.released.map(item => [item.key, item.outcome]),
    [[keyOf(activeLock), 'active']]);
  state = JSON.parse(fs.readFileSync(path.join(context.auditDir, 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.pending), [keyOf(unknownLock)]);
  assert.equal(state.pending[keyOf(unknownLock)].runId, runId);
  assert.equal(state.pending[keyOf(neverLocked)], undefined);
});

test('finalize sends the saved final summary last without browser calls and is idempotent', async t => {
  const context = setup(t);
  const runId = 'finalize-once';
  const paused = campaign(identities[0], 'paused');
  const active = campaign(identities[0], 'active');
  seedAudit(context, auditFor(runId, context.config, [paused, active], {
    closeResults: [verified(paused)],
    pauseReadbacks: [{ profile: 'alpha', ok: true, checkedAt: '2026-09-16T00:01:00.000Z', campaigns: [
      { promotionType: active.promotionType, campaignId: active.campaignId,
        expectedCampaignName: active.campaignName, outcome: 'active', verified: true, current: active },
    ] }],
    recovery: { status: 'awaiting-agent', rounds: 1, checkedAt: '2026-09-16T00:01:00.000Z', unresolved: [] },
  }));
  const messages = [];
  let browserCalls = 0;

  const result = await run({ ...context.options, finalize: runId }, {
    env: envWithWebhook,
    callOpencli() { browserCalls++; throw new Error('finalize must not use the browser'); },
    send(_url, content) { messages.push(content); },
  });

  assert.equal(browserCalls, 0);
  assert.equal(result.notification.status, 'sent');
  assert.equal(result.notification.sent, messages.length);
  assert.ok(messages.length >= 2);
  assert.ok(messages.at(-1).startsWith('# 暂停操作汇总'));
  assert.match(messages.at(-1), /待暂停 2 个/);
  assert.match(messages.at(-1), /已暂停 1 个/);
  assert.ok(messages.slice(0, -1).every(content => content.startsWith('# 千牛推广执行结果')));

  const second = await run({ ...context.options, finalize: runId }, {
    env: {},
    callOpencli() { assert.fail('idempotent finalize must not use the browser'); },
    send() { assert.fail('an already sent audit must not be sent again'); },
  });
  assert.equal(second.notification.status, 'sent');
  assert.equal(second.notification.sent, messages.length);
});

test('finalize refuses uncertain prior delivery instead of automatically resending', async t => {
  for (const status of ['sending', 'failed']) {
    const context = setup(t);
    const runId = `notification-${status}`;
    const row = campaign(identities[0]);
    seedAudit(context, auditFor(runId, context.config, [row], {
      notification: { status, sent: status === 'sending' ? 1 : 0 },
      recovery: { status: 'awaiting-agent', rounds: 1, checkedAt: '2026-09-16T00:01:00.000Z', unresolved: [] },
    }));
    let sideEffects = 0;
    await assert.rejects(run({ ...context.options, finalize: runId }, {
      env: envWithWebhook,
      callOpencli() { sideEffects++; }, send() { sideEffects++; },
    }), /Previous notification may have been delivered/);
    assert.equal(sideEffects, 0);
  }
});

test('an execute partial is recovered read-only and archived after final persistence', async t => {
  const context = setup(t);
  const runId = 'partial-recovery';
  const row = campaign(identities[0]);
  const partial = auditFor(runId, context.config, [], {
    results: [row], shops: [{ profile: 'alpha', browserUser: identities[0].browserUser, ok: true }],
    current: { type: 'pause', profile: 'alpha', campaignId: row.campaignId, status: 'pending' },
  });
  delete partial.scanned;
  delete partial.lowRoi;
  delete partial.toClose;
  delete partial.notification;
  delete partial.recovery;
  seedAudit(context, partial, { partial: true,
    state: { paused: {}, pending: { [keyOf(row)]: { ...row, runId, status: 'pending' } } } });
  const calls = [];

  const result = await run({ ...context.options, recover: runId }, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      calls.push(args[3]);
      return verificationResult(identities[0], targetsFrom(args), 'inactive');
    },
  });

  assert.deepEqual(calls, ['scan-campaigns']);
  assert.equal(result.toClose.length, 1);
  assert.equal(result.closeResults.length, 1);
  assert.ok(fs.existsSync(path.join(context.auditDir, `${runId}.json`)));
  assert.ok(fs.existsSync(path.join(context.auditDir, `${runId}.recovered-checkpoint.json`)));
  assert.ok(!fs.existsSync(path.join(context.auditDir, `${runId}.partial.json`)));
});

test('the CLI can load recovery without a top-level-await module cycle', t => {
  const context = setup(t);
  const runId = 'cli-finalize-cycle';
  seedAudit(context, auditFor(runId, context.config, [], {
    notification: { status: 'sent', sent: 1 },
    recovery: { status: 'resolved', rounds: 1, checkedAt: '2026-09-16T00:01:00.000Z', unresolved: [] },
  }));

  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../runner.mjs', import.meta.url)),
    '--finalize', runId, '--config', context.configPath, '--audit-dir', context.auditDir], {
    encoding: 'utf8', timeout: 10000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
  assert.equal(JSON.parse(result.stdout).runId, runId);
});

test('the runner lock rejects a concurrent recovery before any browser or notification work', async t => {
  const context = setup(t);
  const runId = 'locked-recovery';
  const row = campaign(identities[0]);
  seedAudit(context, auditFor(runId, context.config, [row]));
  fs.writeFileSync(path.join(context.auditDir, 'runner.lock'), JSON.stringify({ pid: process.pid }));
  let sideEffects = 0;

  await assert.rejects(run({ ...context.options, recover: runId }, {
    env: envWithWebhook,
    callOpencli() { sideEffects++; }, send() { sideEffects++; },
  }), /Another runner is active/);
  assert.equal(sideEffects, 0);
});

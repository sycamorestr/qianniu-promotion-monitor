import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, run, selectCampaigns, splitMessages, validateConfig, buildMessages } from '../runner.mjs';

const thresholds = { notifyRoiBelow: 2, closeChargeAbove: 30, closeRoiBelow: 1.5 };
const identities = [
  { profile: 'alpha', browserUser: '示例甲', expectedAlimamaShop: '页面甲' },
  { profile: 'beta', browserUser: '示例乙', expectedAlimamaShop: '页面乙' },
];
function configFor(profiles = identities) {
  return { profiles, allowedBrowserUsers: profiles.map(row => row.browserUser), thresholds, limits: { retries: 2, pageSize: 500, maxPages: 50 } };
}
function campaign(identity, overrides = {}) {
  return { recordType: 'campaign', shopName: identity.expectedAlimamaShop, campaignId: 'shared-id',
    campaignName: '示例计划', promotionType: '全站推', roi: 1, charge: 40, displayStatus: 'start', onlineStatus: 1, ...overrides };
}
function scanResult(identity, overrides) {
  return [{ recordType: 'identity', shopName: identity.expectedAlimamaShop }, campaign(identity, overrides)];
}
function setup(t, mode = 'report', config = configFor()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qianniu-runner-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { mode, configPath, auditDir: path.join(dir, 'audit') };
}
const envWithWebhook = { WECHAT_WEBHOOK_URL: 'https://example.invalid/never-contacted' };
const option = (args, name) => args[args.indexOf(name) + 1];

test('default invocation is local report and validates arguments', () => {
  assert.equal(parseArgs([]).mode, 'report');
  assert.equal(parseArgs(['--mode=execute']).mode, 'execute');
  assert.throws(() => parseArgs(['--mode', 'unknown']));
  assert.throws(() => parseArgs(['--unexpected']));
});

test('configuration allows one or many shops but rejects missing identity and whitelist violations', () => {
  assert.equal(validateConfig(configFor([identities[0]])).profiles.length, 1);
  assert.equal(validateConfig(configFor()).profiles.length, 2);
  assert.throws(() => validateConfig(configFor([])));
  assert.throws(() => validateConfig(configFor([identities[0], identities[0]])));
  assert.throws(() => validateConfig({ ...configFor(), allowedBrowserUsers: ['未知'] }));
  assert.throws(() => validateConfig(configFor([{ ...identities[0], expectedAlimamaShop: '' }])));
});

test('strict active state and original metric boundaries determine the action list', () => {
  const id = identities[0];
  const rows = [
    campaign(id, { campaignId: 'at-notify', roi: 2 }),
    campaign(id, { campaignId: 'at-roi', roi: 1.5 }),
    campaign(id, { campaignId: 'at-charge', charge: 30 }),
    campaign(id, { campaignId: 'close-below', roi: 1.49999, charge: 30.00001 }),
    campaign(id, { campaignId: 'off-display', displayStatus: 'pause' }),
    campaign(id, { campaignId: 'off-online', onlineStatus: 0 }),
    campaign(id, { campaignId: 'missing', roi: null }),
  ];
  const selection = selectCampaigns(rows, thresholds);
  assert.deepEqual(selection.toClose.map(row => row.campaignId), ['close-below']);
  assert.deepEqual(selection.lowRoi.map(row => row.campaignId), ['at-roi', 'at-charge', 'close-below']);
});

test('scan validation rejects empty campaign names before they can become pause candidates', async t => {
  let calls = 0;
  const result = await run(setup(t, 'report', configFor([identities[0]])), {
    log() {},
    callOpencli() {
      calls++;
      return scanResult(identities[0], { campaignName: '   ' });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.shops[0].ok, false);
  assert.equal(result.toClose.length, 0);
});

test('report cannot notify or pause even when a webhook exists; saves a final audit', async t => {
  const options = setup(t);
  const calls = [];
  const result = await run(options, {
    env: envWithWebhook, log() {}, send() { assert.fail('report must not send'); },
    callOpencli(args) {
      calls.push(args);
      assert.equal(args[3], 'scan-campaigns');
      return scanResult(identities.find(row => row.profile === args[1]));
    },
  });
  assert.deepEqual(calls.map(args => args[1]), ['alpha', 'beta']);
  assert.equal(result.toClose.length, 2);
  assert.equal(result.closeResults.length, 0);
  assert.equal(result.notification.status, 'disabled');
  const files = fs.readdirSync(options.auditDir);
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes('.partial'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.auditDir, files[0]))).mode, 'report');
});

test('dry-run sends only after every shop has finished and never pauses', async t => {
  const events = [], notifications = [];
  const result = await run(setup(t, 'dry-run'), {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      assert.equal(args[3], 'scan-campaigns');
      events.push(args[1]);
      assert.equal(option(args, '--keep-tab'), 'false');
      assert.equal(option(args, '--site-session'), 'ephemeral');
      return scanResult(identities.find(row => row.profile === args[1]));
    },
    send(_url, content) {
      events.push('notify');
      notifications.push(content);
      assert.ok(Buffer.byteLength(content) <= 4000);
    },
  });
  assert.deepEqual(events.slice(0, 3), ['alpha', 'beta', 'notify']);
  assert.equal(result.notification.status, 'sent');
  assert.equal(result.closeResults.length, 0);
  const notification = notifications.join('\n');
  assert.match(notification, /^# 千牛推广巡检提醒/m);
  assert.match(notification, /^## 示例甲/m);
  assert.match(notification, /^## 示例乙/m);
  assert.match(notification, /<font color="warning">建议暂停<\/font>/);
  assert.doesNotMatch(notification, /推广已暂停|推广未暂停/);
});

test('execute summaries show only non-zero pause outcomes and explain an empty action list', () => {
  const identity = identities[0];
  const row = { ...campaign(identity), profile: identity.profile, browserUser: identity.browserUser };
  const base = {
    mode: 'execute', scanned: 1,
    shops: [{ profile: identity.profile, browserUser: identity.browserUser, ok: true }],
    lowRoi: [row], pauseReadbacks: [], failures: [],
  };
  const completed = buildMessages({ ...base, toClose: [row], closeResults: [{ ...row, verified: true }] }, configFor([identity])).join('\n');
  assert.match(completed, /推广已暂停 1 个/);
  assert.doesNotMatch(completed, /推广未暂停\s*0\s*个/);

  const unpaused = buildMessages({ ...base, toClose: [row], closeResults: [] }, configFor([identity])).join('\n');
  assert.match(unpaused, /推广未暂停 1 个/);
  assert.doesNotMatch(unpaused, /推广已暂停\s*0\s*个/);

  const second = { ...row, campaignId: 'second-plan', campaignName: '示例计划 B' };
  const mixed = buildMessages({ ...base, scanned: 2, lowRoi: [row, second], toClose: [row, second],
    closeResults: [{ ...row, verified: true }] }, configFor([identity])).join('\n');
  assert.match(mixed, /推广已暂停 1 个/);
  assert.match(mixed, /推广未暂停 1 个/);

  const empty = buildMessages({ ...base, lowRoi: [], toClose: [], closeResults: [] }, configFor([identity])).join('\n');
  assert.match(empty, /本次无符合暂停条件的推广/);
  assert.doesNotMatch(empty, /推广(?:已暂停|未暂停)\s*0\s*个/);
});

test('execute supplies current identity and thresholds; uncertain writes receive one final shop read-back', async t => {
  const events = [], pauses = [], notifications = [];
  const result = await run(setup(t, 'execute'), {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      const identity = identities.find(row => row.profile === args[1]);
      events.push(`${args[3]}:${identity.profile}`);
      if (args[3] === 'scan-campaigns') return scanResult(identity);
      pauses.push(identity.profile);
      assert.equal(option(args, '--expected-shop'), identity.expectedAlimamaShop);
      assert.equal(option(args, '--expected-name'), '示例计划');
      assert.equal(option(args, '--max-roi'), '1.5');
      assert.equal(option(args, '--min-charge'), '30');
      if (identity.profile === 'beta') throw new Error('uncertain write');
      return { ok: true, verified: true, shopName: identity.expectedAlimamaShop, promotionType: '全站推',
        campaignId: 'shared-id', campaignName: '示例计划', writeAttempted: true, afterStatus: 'not-in-active-list' };
    },
    send(_url, content) {
      events.push('notify');
      notifications.push(content);
    },
  });
  assert.deepEqual(pauses, ['alpha', 'beta']);
  assert.deepEqual(events, ['scan-campaigns:alpha', 'scan-campaigns:beta', 'pause-campaign:alpha',
    'pause-campaign:beta', 'scan-campaigns:beta', 'notify']);
  assert.equal(result.closeResults.length, 1);
  assert.equal(result.closeResults[0].profile, 'alpha');
  assert.equal(result.pauseReadbacks.length, 1);
  assert.equal(result.pauseReadbacks[0].campaigns[0].outcome, 'active');
  assert.equal(result.failures[0].type, 'pause');
  const notification = notifications.join('\n');
  const alphaSection = notification.split('## 示例甲')[1].split('## 示例乙')[0];
  const betaSection = notification.split('## 示例乙')[1];
  assert.match(alphaSection, /<font color="info">推广已暂停<\/font>/);
  assert.doesNotMatch(alphaSection, /<font color="warning">推广未暂停<\/font>/);
  assert.match(betaSection, /<font color="warning">推广未暂停<\/font>/);
  assert.doesNotMatch(betaSection, /<font color="info">推广已暂停<\/font>/);
  assert.match(notification, /<font color="comment">全站推｜花费 40\.00｜ROI 1\.00｜ID shared-id<\/font>/);
  assert.doesNotMatch(notification, /uncertain write|not-in-active-list|当前不活动|未归因|归因|待停止计划|最终核验/);
});

test('an accepted pause followed by a timeout is reported as paused when the final complete scan proves inactivity', async t => {
  const identity = identities[0];
  const options = setup(t, 'execute', configFor([identity]));
  const events = [], notifications = [];
  let scans = 0, pauses = 0;
  const result = await run(options, {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      events.push(args[3]);
      if (args[3] === 'scan-campaigns') {
        scans++;
        return scans === 1
          ? scanResult(identity)
          : [{ recordType: 'identity', shopName: identity.expectedAlimamaShop }];
      }
      pauses++;
      throw new Error('response timed out after the server accepted the write');
    },
    send(_url, content) { notifications.push(content); },
  });

  assert.deepEqual(events, ['scan-campaigns', 'pause-campaign', 'scan-campaigns']);
  assert.equal(pauses, 1);
  assert.equal(result.closeResults.length, 1);
  assert.equal(result.closeResults[0].verificationSource, 'final-readback');
  assert.equal(result.pauseReadbacks.length, 1);
  assert.equal(result.pauseReadbacks[0].campaigns[0].outcome, 'inactive');
  const state = JSON.parse(fs.readFileSync(path.join(options.auditDir, 'state.json'), 'utf8'));
  assert.equal(state.paused['alpha|全站推|shared-id'].result.verificationSource, 'final-readback');
  assert.match(notifications.join('\n'), /<font color="info">推广已暂停<\/font>/);
  assert.doesNotMatch(notifications.join('\n'), /<font color="warning">推广未暂停<\/font>/);
});

test('one combined final read-back per shop keeps active plans unpaused and displays fresh metrics', async t => {
  const identity = identities[0];
  const initial = [
    { recordType: 'identity', shopName: identity.expectedAlimamaShop },
    campaign(identity, { campaignId: 'plan-a', campaignName: '计划 A', roi: 1.1, charge: 41 }),
    campaign(identity, { campaignId: 'plan-b', campaignName: '计划 B', roi: 1.2, charge: 42 }),
  ];
  const current = [
    { recordType: 'identity', shopName: identity.expectedAlimamaShop },
    campaign(identity, { campaignId: 'plan-a', campaignName: '计划 A', roi: 1.61, charge: 104.05 }),
    campaign(identity, { campaignId: 'plan-b', campaignName: '计划 B', roi: 1.72, charge: 88.09 }),
  ];
  let scans = 0, pauses = 0;
  const notifications = [];
  const result = await run(setup(t, 'execute', configFor([identity])), {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      if (args[3] === 'scan-campaigns') return ++scans === 1 ? initial : current;
      pauses++;
      throw new Error('pause command timed out before returning');
    },
    send(_url, content) { notifications.push(content); },
  });

  assert.equal(scans, 2);
  assert.equal(pauses, 2);
  assert.equal(result.closeResults.length, 0);
  assert.deepEqual(result.pauseReadbacks[0].campaigns.map(row => row.outcome), ['active', 'active']);
  const notification = notifications.join('\n');
  assert.equal((notification.match(/<font color="warning">推广未暂停<\/font>/g) || []).length, 2);
  assert.match(notification, /计划 A｜<font color="comment">全站推｜花费 104\.05｜ROI 1\.61｜ID plan-a<\/font>/);
  assert.match(notification, /计划 B｜<font color="comment">全站推｜花费 88\.09｜ROI 1\.72｜ID plan-b<\/font>/);
  assert.doesNotMatch(notification, /计划 A｜<font color="comment">全站推｜花费 41\.00｜ROI 1\.10/);
});

test('a failed final read-back remains conservatively unpaused and is not retried', async t => {
  const identity = identities[0];
  let scans = 0, pauses = 0;
  const notifications = [];
  const result = await run(setup(t, 'execute', configFor([identity])), {
    env: envWithWebhook, log() {},
    callOpencli(args) {
      if (args[3] === 'scan-campaigns') {
        scans++;
        if (scans === 1) return scanResult(identity);
        throw new Error('read-back unavailable');
      }
      pauses++;
      throw new Error('pause outcome uncertain');
    },
    send(_url, content) { notifications.push(content); },
  });

  assert.equal(scans, 2);
  assert.equal(pauses, 1);
  assert.equal(result.closeResults.length, 0);
  assert.equal(result.pauseReadbacks[0].ok, false);
  assert.equal(result.pauseReadbacks[0].campaigns[0].outcome, 'unverified');
  assert.deepEqual(result.failures.map(row => row.type), ['pause', 'pause-readback']);
  const notification = notifications.join('\n');
  assert.match(notification, /<font color="warning">推广未暂停<\/font>/);
  assert.doesNotMatch(notification, /read-back unavailable|pause outcome uncertain/);
});

test('a changed campaign name in the final scan remains conservatively unpaused', async t => {
  const identity = identities[0];
  let scans = 0;
  const result = await run(setup(t, 'execute', configFor([identity])), {
    env: envWithWebhook, log() {}, send() {},
    callOpencli(args) {
      if (args[3] === 'scan-campaigns') {
        scans++;
        return scanResult(identity, scans === 1 ? {} : { campaignName: '另一个计划', roi: 1.8, charge: 99 });
      }
      throw new Error('pause outcome uncertain');
    },
  });

  assert.equal(result.closeResults.length, 0);
  assert.equal(result.pauseReadbacks[0].campaigns[0].outcome, 'identity-mismatch');
  assert.ok(result.failures.some(row => row.type === 'pause-readback' && row.campaignId === 'shared-id'));
  assert.match(buildMessages(result, configFor([identity])).join('\n'), /推广未暂停/);
});

test('a shop with mismatched returned campaign identity fails independently; successful shop can still be processed', async t => {
  const result = await run(setup(t, 'execute'), {
    env: envWithWebhook, log() {}, send() {},
    callOpencli(args) {
      const identity = identities.find(row => row.profile === args[1]);
      if (args[3] === 'scan-campaigns') return scanResult(identity, identity.profile === 'alpha' ? { shopName: '错误店铺' } : {});
      assert.equal(identity.profile, 'beta');
      return { ok: true, verified: true, writeAttempted: true, afterStatus: 'not-in-active-list',
        shopName: identity.expectedAlimamaShop, promotionType: '全站推', campaignId: 'shared-id', campaignName: '示例计划' };
    },
  });
  assert.equal(result.failures.length, 1);
  assert.equal(result.shops[0].ok, false);
  assert.equal(result.shops[1].ok, true);
  assert.equal(result.closeResults[0].profile, 'beta');
  assert.match(buildMessages(result, configFor()).join(''), /本店巡检未完成/);
});

test('a preview-shaped or mismatched pause response is never recorded as verified success', async t => {
  const result = await run(setup(t, 'execute', configFor([identities[0]])), {
    env: envWithWebhook, log() {}, send() {},
    callOpencli(args) {
      if (args[3] === 'scan-campaigns') return scanResult(identities[0]);
      return { ok: true, verified: false, shopName: '页面甲', promotionType: '全站推', campaignId: 'shared-id', campaignName: '示例计划' };
    },
  });
  assert.equal(result.closeResults.length, 0);
  assert.equal(result.failures[0].type, 'pause');
});

test('a response missing write evidence is reconciled by read-back instead of counted as a pause success', async t => {
  const identity = identities[0];
  let scans = 0, pauses = 0;
  const result = await run(setup(t, 'execute', configFor([identity])), {
    env: envWithWebhook, log() {}, send() {},
    callOpencli(args) {
      if (args[3] === 'scan-campaigns') {
        scans++;
        return scans === 1 ? scanResult(identity) : [{ recordType: 'identity', shopName: identity.expectedAlimamaShop }];
      }
      pauses++;
      return { ok: true, verified: true, shopName: identity.expectedAlimamaShop, promotionType: '全站推',
        campaignId: 'shared-id', campaignName: '示例计划', afterStatus: 'not-in-active-list' };
    },
  });
  assert.equal(scans, 2);
  assert.equal(pauses, 1);
  assert.equal(result.closeResults.length, 1);
  assert.equal(result.closeResults[0].verificationSource, 'final-readback');
  assert.equal(result.failures[0].type, 'pause');
});

test('directly verified pauses do not trigger an unnecessary final scan', async t => {
  const identity = identities[0];
  let scans = 0, pauses = 0;
  const result = await run(setup(t, 'execute', configFor([identity])), {
    env: envWithWebhook, log() {}, send() {},
    callOpencli(args) {
      if (args[3] === 'scan-campaigns') { scans++; return scanResult(identity); }
      pauses++;
      return { ok: true, verified: true, writeAttempted: true, afterStatus: 'pause',
        shopName: identity.expectedAlimamaShop, promotionType: '全站推', campaignId: 'shared-id', campaignName: '示例计划' };
    },
  });
  assert.equal(scans, 1);
  assert.equal(pauses, 1);
  assert.equal(result.pauseReadbacks.length, 0);
  assert.equal(result.closeResults.length, 1);
});

test('same campaign ID under another promotion type is not treated as absent', async t => {
  const identity = identities[0];
  const initial = [
    { recordType: 'identity', shopName: identity.expectedAlimamaShop },
    campaign(identity, { campaignId: 'shared-id', campaignName: '全站计划', promotionType: '全站推' }),
    campaign(identity, { campaignId: 'shared-id', campaignName: '关键词计划', promotionType: '关键词推广' }),
  ];
  const current = [
    { recordType: 'identity', shopName: identity.expectedAlimamaShop },
    campaign(identity, { campaignId: 'shared-id', campaignName: '关键词计划', promotionType: '关键词推广' }),
  ];
  let scans = 0, pauses = 0;
  const result = await run(setup(t, 'execute', configFor([identity])), {
    env: envWithWebhook, log() {}, send() {},
    callOpencli(args) {
      if (args[3] === 'scan-campaigns') return ++scans === 1 ? initial : current;
      pauses++;
      throw new Error('pause outcome uncertain');
    },
  });
  assert.equal(scans, 2);
  assert.equal(pauses, 2);
  assert.equal(result.closeResults.length, 0);
  assert.deepEqual(result.pauseReadbacks[0].campaigns.map(row => row.outcome), ['identity-mismatch', 'active']);
});

test('notification failures are saved without repeating scans or sends and never include the webhook', async t => {
  const options = setup(t, 'dry-run', configFor([identities[0]]));
  let scanned = 0, sent = 0;
  const result = await run(options, {
    env: envWithWebhook, log() {},
    callOpencli() { scanned++; return scanResult(identities[0]); },
    send() { sent++; throw new Error(envWithWebhook.WECHAT_WEBHOOK_URL); },
  });
  assert.equal(scanned, 1);
  assert.equal(sent, 1);
  assert.equal(result.notification.status, 'failed');
  const audit = fs.readFileSync(path.join(options.auditDir, `${result.runId}.json`), 'utf8');
  assert.doesNotMatch(audit, /never-contacted/);
  assert.equal(JSON.parse(audit).failures[0].type, 'notification');
});

test('an unfinished execute checkpoint blocks a second write attempt', async t => {
  const options = setup(t, 'execute', configFor([identities[0]]));
  fs.mkdirSync(options.auditDir, { recursive: true });
  fs.writeFileSync(path.join(options.auditDir, 'unfinished.partial.json'), JSON.stringify({ mode: 'execute' }));
  let calls = 0;
  await assert.rejects(run(options, {
    env: envWithWebhook, log() {}, callOpencli() { calls++; return scanResult(identities[0]); }, send() {},
  }), /unfinished execute checkpoint/);
  assert.equal(calls, 0);
});

test('UTF-8 notification limits also hold for one very long multibyte campaign name', () => {
  const chunks = splitMessages('# 千牛推广巡检', ['- ' + '中文😀'.repeat(3000)]);
  assert.ok(chunks.length > 1);
  for (const content of chunks) {
    assert.ok(Buffer.byteLength(content, 'utf8') <= 4000);
    assert.doesNotMatch(content, /\uFFFD/);
  }
});

test('styled shop messages split without losing context, plan rows, or balanced color tags', () => {
  const identity = identities[0];
  const rows = Array.from({ length: 140 }, (_, index) => campaign(identity, {
    profile: identity.profile,
    browserUser: identity.browserUser,
    campaignId: `plan-${String(index).padStart(3, '0')}`,
    campaignName: `超长运营计划${index}-${'中文😀'.repeat(100)}`,
    roi: 1 + index / 1000,
    charge: 40 + index,
  }));
  const toClose = rows.slice(0, 6);
  const payload = {
    mode: 'execute', scanned: rows.length,
    shops: [{ profile: identity.profile, browserUser: identity.browserUser, ok: true }],
    lowRoi: rows, toClose,
    closeResults: toClose.slice(0, 3).map(row => ({ ...row, verified: true })),
    failures: [{ profile: identity.profile, type: 'pause', message: 'failure-secret-must-not-render' }],
  };
  const messages = buildMessages(payload, configFor([identity]));
  assert.ok(messages.length > 1);
  const notification = messages.join('\n');
  for (const content of messages) {
    assert.ok(Buffer.byteLength(content, 'utf8') <= 4000);
    assert.match(content, /^# 千牛推广执行结果/m);
    assert.match(content, /^## 示例甲/m);
    assert.doesNotMatch(content, /\uFFFD/);
    assert.equal((content.match(/<font color="(?:info|warning|comment)">/g) || []).length,
      (content.match(/<\/font>/g) || []).length);
    for (const line of content.split('\n').filter(row => row.includes('｜ID plan-'))) {
      assert.match(line, /^- /);
      assert.match(line, /<\/font>$/);
    }
  }
  for (const row of rows) assert.equal(notification.split(`ID ${row.campaignId}</font>`).length - 1, 1);
  assert.match(notification, /<font color="info">推广已暂停<\/font>/);
  assert.match(notification, /<font color="warning">推广未暂停<\/font>/);
  assert.doesNotMatch(notification, /failure-secret-must-not-render|当前不活动|未归因|归因/);
});

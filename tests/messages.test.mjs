import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, splitMessages, splitShopMessages } from '../messages.mjs';

const profiles = [
  { profile: 'alpha', browserUser: '示例甲', expectedAlimamaShop: '页面甲' },
  { profile: 'beta', browserUser: '示例乙', expectedAlimamaShop: '页面乙' },
];
const config = { profiles, thresholds: { notifyRoiBelow: 2, closeChargeAbove: 30, closeRoiBelow: 1.5 } };
const campaign = (campaignId, overrides = {}) => ({
  profile: 'alpha', browserUser: '示例甲', shopName: '页面甲', promotionType: '全站推',
  campaignId, campaignName: `计划 ${campaignId}`, charge: 40, roi: 1, displayStatus: 'start', onlineStatus: 1,
  ...overrides,
});
const payloadFor = (rows, overrides = {}) => ({
  mode: 'execute', scanned: rows.length,
  shops: profiles.map(identity => ({ profile: identity.profile, ok: true })),
  lowRoi: rows, toClose: rows, closeResults: [], pauseReadbacks: [], failures: [], ...overrides,
});
const readbackFor = (row, outcome, overrides = {}) => ({
  profile: row.profile, ok: true,
  campaigns: [{ promotionType: row.promotionType, campaignId: row.campaignId,
    expectedCampaignName: row.campaignName, verified: true, outcome, current: outcome === 'active' ? row : null }],
  ...overrides,
});
const verified = row => ({ ...row, verified: true, afterStatus: 'pause' });
const summaryFor = payload => buildMessages(payload, config).filter(part => part.startsWith('# 暂停操作汇总')).join('\n');

test('all original candidates remain in 待暂停; final verified candidates also appear once in 已暂停', () => {
  const first = campaign('first'), second = campaign('second'), ordinary = campaign('ordinary', { roi: 1.8 });
  const messages = buildMessages(payloadFor([first, second, ordinary], {
    toClose: [first, second, first], closeResults: [verified(first)],
  }), config);
  const summary = messages.filter(part => part.startsWith('# 暂停操作汇总')).join('\n');
  const ordinaryParts = messages.filter(part => !part.startsWith('# 暂停操作汇总')).join('\n');
  assert.match(summary, /待暂停 2 个/);
  assert.match(summary, /已暂停 1 个/);
  const waiting = summary.split('### 待暂停')[1].split('### 已暂停')[0];
  const paused = summary.split('### 已暂停')[1];
  assert.equal(waiting.split('ID first').length - 1, 1);
  assert.equal(waiting.split('ID second').length - 1, 1);
  assert.equal(paused.split('ID first').length - 1, 1);
  assert.doesNotMatch(paused, /ID second/);
  assert.doesNotMatch(ordinaryParts, /ID first|ID second/);
  assert.match(ordinaryParts, /ID ordinary/);
  assert.doesNotMatch(summary, /ID ordinary|推广未暂停|建议暂停|已暂停 0 个/);
});

test('latest active readback overrides a previous verified pause and reports fresh eligible metrics', () => {
  const row = campaign('active');
  const current = { ...row, charge: 99.04, roi: 1.21 };
  const summary = summaryFor(payloadFor([row], {
    closeResults: [verified(row)],
    pauseReadbacks: [readbackFor(row, 'inactive'), readbackFor(current, 'active')],
  }));
  assert.match(summary, /待暂停 1 个/);
  assert.match(summary, /花费 99\.04｜ROI 1\.21/);
  assert.match(summary, /仍在推广/);
  assert.doesNotMatch(summary, /### 已暂停|已暂停 1 个|指标已改善|推广未暂停/);
});

test('latest final inactivity is sufficient without a close result and uses latest timestamp', () => {
  const row = campaign('inactive');
  const summary = summaryFor(payloadFor([row], {
    pauseReadbacks: [
      readbackFor(row, 'inactive', { checkedAt: '2026-09-16T05:00:02Z' }),
      readbackFor(row, 'active', { checkedAt: '2026-09-16T05:00:01Z' }),
    ],
  }));
  assert.match(summary, /已暂停 1 个/);
  assert.equal((summary.match(/ID inactive/g) || []).length, 2);
});

test('a failed or unverified latest readback suppresses earlier successes', () => {
  const row = campaign('uncertain');
  for (const last of [
    readbackFor(row, 'inactive', { ok: false }),
    readbackFor(row, 'unverified'),
    { ...readbackFor(row, 'inactive'), campaigns: [{ ...readbackFor(row, 'inactive').campaigns[0], verified: false }] },
    { ...readbackFor(row, 'inactive'), campaigns: [{ ...readbackFor(row, 'inactive').campaigns[0], expectedCampaignName: '别的计划' }] },
  ]) {
    const summary = summaryFor(payloadFor([row], {
      closeResults: [verified(row)], pauseReadbacks: [readbackFor(row, 'inactive'), last],
    }));
    assert.match(summary, /待核验/);
    assert.doesNotMatch(summary, /### 已暂停|已暂停 1 个/);
  }
});

test('a close result alone requires verified=true and a recognized inactive status', () => {
  const row = campaign('direct');
  for (const result of [row, { ...row, verified: true }, { ...row, verified: false, afterStatus: 'pause' },
    { ...row, verified: true, afterStatus: 'start' }, { ...verified(row), campaignName: '别的计划' }]) {
    const summary = summaryFor(payloadFor([row], { closeResults: [result] }));
    assert.doesNotMatch(summary, /### 已暂停|已暂停 1 个/);
  }
  for (const afterStatus of ['pause', 'not-in-active-list']) {
    assert.match(summaryFor(payloadFor([row], { closeResults: [{ ...verified(row), afterStatus }] })), /已暂停 1 个/);
  }
});

test('improved final metrics annotate the original action list without inventing another count', () => {
  const row = campaign('improved');
  const current = { ...row, charge: 104.05, roi: 1.61 };
  const summary = summaryFor(payloadFor([row], { pauseReadbacks: [readbackFor(current, 'active')] }));
  assert.match(summary, /待暂停 1 个/);
  assert.match(summary, /无需暂停（指标已改善）/);
  assert.match(summary, /花费 104\.05｜ROI 1\.61/);
  assert.doesNotMatch(summary, /无需暂停 1 个|已暂停 1 个|推广未暂停/);
  const unknown = summaryFor(payloadFor([row], { pauseReadbacks: [readbackFor({ ...row, roi: null }, 'active')] }));
  assert.doesNotMatch(unknown, /指标已改善/);
});

test('dry-run uses 待暂停 and never displays an 已暂停 stage, even with stale results', () => {
  const row = campaign('preview');
  const summary = summaryFor(payloadFor([row], { mode: 'dry-run', closeResults: [verified(row)], pauseReadbacks: [readbackFor(row, 'inactive')] }));
  assert.match(summary, /待暂停 1 个/);
  assert.match(summary, /本次未执行暂停/);
  assert.doesNotMatch(summary, /已暂停|建议暂停|推广未暂停|待核验/);
});

test('empty work lists omit zero pause counts and operation summaries', () => {
  for (const mode of ['execute', 'dry-run', 'report']) {
    const messages = buildMessages(payloadFor([], { mode }), config);
    assert.ok(messages.every(part => !part.startsWith('# 暂停操作汇总')));
    assert.match(messages.join('\n'), /本次无符合暂停条件的推广/);
    assert.doesNotMatch(messages.join('\n'), /(?:待暂停|已暂停|未暂停)\s*0\s*个/);
  }
});

test('operation summary stays last across UTF-8 chunks, retaining shop and stage context', () => {
  const rows = Array.from({ length: 110 }, (_, index) => campaign(`plan-${String(index).padStart(3, '0')}`, {
    campaignName: `长计划${index}-${'中文😀'.repeat(100)}`,
    ...(index >= 55 ? { profile: 'beta', browserUser: '示例乙', shopName: '页面乙', promotionType: '关键词推广' } : {}),
  }));
  const candidates = rows.filter((_, index) => index % 2 === 0);
  const paused = candidates.filter((_, index) => index % 2 === 0);
  const messages = buildMessages(payloadFor(rows, { toClose: candidates, closeResults: paused.map(verified) }), config);
  const firstOperation = messages.findIndex(part => part.startsWith('# 暂停操作汇总'));
  assert.ok(firstOperation > 1);
  assert.ok(messages.length - firstOperation > 1);
  assert.ok(messages.slice(firstOperation).every(part => part.startsWith('# 暂停操作汇总')));
  assert.ok(messages.slice(0, firstOperation).every(part => part.startsWith('# 千牛推广执行结果')));
  for (const content of messages) {
    assert.ok(Buffer.byteLength(content, 'utf8') <= 4000);
    assert.match(content, /^## 示例[甲乙]/m);
    assert.doesNotMatch(content, /\uFFFD/);
    assert.equal((content.match(/<font color="(?:info|warning|comment)">/g) || []).length,
      (content.match(/<\/font>/g) || []).length);
    for (const line of content.split('\n').filter(line => line.includes('ID plan-'))) {
      assert.match(line, /^- /);
      assert.match(line, /<\/font>$/);
    }
  }
  const waitingLines = messages.flatMap(part => part.split('\n')).filter(line => line.startsWith('- <font color="warning">待暂停</font>'));
  const pausedLines = messages.flatMap(part => part.split('\n')).filter(line => line.startsWith('- <font color="info">已暂停</font>'));
  for (const row of candidates) assert.equal(waitingLines.filter(line => line.includes(`ID ${row.campaignId}</font>`)).length, 1);
  for (const row of paused) assert.equal(pausedLines.filter(line => line.includes(`ID ${row.campaignId}</font>`)).length, 1);
  assert.equal(waitingLines.length, candidates.length);
  assert.equal(pausedLines.length, paused.length);
  const normal = messages.slice(0, firstOperation).join('\n');
  for (const row of candidates) assert.ok(!normal.includes(`ID ${row.campaignId}</font>`));
});

test('shared IDs retain shop and promotion-type boundaries', () => {
  const first = campaign('shared');
  const keyword = { ...first, promotionType: '关键词推广' };
  const otherShop = { ...first, profile: 'beta', browserUser: '示例乙', shopName: '页面乙' };
  const summary = summaryFor(payloadFor([first, keyword, otherShop], { pauseReadbacks: [readbackFor(keyword, 'inactive')] }));
  assert.match(summary, /待暂停 3 个/);
  assert.match(summary, /已暂停 1 个/);
  const pausedLine = summary.split('\n').find(line => line.startsWith('- <font color="info">已暂停</font>'));
  assert.match(pausedLine, /关键词推广/);
  assert.doesNotMatch(summary.split('## 示例乙')[1], /### 已暂停/);
});

test('exported splitters preserve UTF-8 characters and reject an oversized context', () => {
  const chunks = splitMessages('# 巡检', ['中文😀'.repeat(3000)]);
  assert.ok(chunks.length > 1);
  for (const content of chunks) {
    assert.ok(Buffer.byteLength(content, 'utf8') <= 4000);
    assert.doesNotMatch(content, /\uFFFD/);
  }
  assert.throws(() => splitShopMessages('#'.repeat(4000), []), /header too long/);
});

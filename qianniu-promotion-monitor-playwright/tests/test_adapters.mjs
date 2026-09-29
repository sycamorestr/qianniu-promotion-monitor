import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const adapterRoot = new URL('../adapters/', import.meta.url);
const scanSource = fs.readFileSync(new URL('scan_campaigns.js', adapterRoot), 'utf8');
const pauseSource = fs.readFileSync(new URL('pause_campaign.js', adapterRoot), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const context = (overrides = {}) => ({
  sourceList: ['confirmed-source'], adzonePkgIdList: [], effectEqual: 'equal',
  unifyType: 'retained', startTime: '2026-09-20', endTime: '2026-09-20', isRt: false,
  ...overrides,
});
const campaign = (overrides = {}) => ({
  campaignId: '101', campaignName: '精确计划', displayStatus: 'start', onlineStatus: 1,
  reportInfoList: [{ retainedRoi: '1.234567', roi: '1.4', charge: '30.0001' }],
  bizCode: 'campaign-biz', sourceChannel: 'source-channel', channelLocation: 'location',
  ...overrides,
});

function fixture({ type = 'all-site', nick = '示例店:子账号', pages, onQuery, onWrite,
  submitOverrides = {}, conditionOverrides = {} } = {}) {
  let account = nick;
  const queries = [];
  const writes = [];
  const submit = {
    csrfId: 'fixture-private-csrf', loginPointId: 'fixture-login', bizCode: 'biz',
    // These retained UI filters must never hide candidates from a full scan.
    campaignId: 'stale-id', campaignName: 'stale-name', statusList: ['pause'],
    rptQuery: { fields: 'charge', conditionList: [context(conditionOverrides)] },
    ...submitOverrides,
  };
  const view = {
    updater: { get: key => key === 'submitParams' ? submit : key === 'user'
      ? { meta: { nickName: account } } : undefined },
    requester: { campaign_horizontal_findPage_post: async params => {
      queries.push(clone(params));
      const index = queries.length - 1;
      if (onQuery) return onQuery(params, index, value => { account = value; });
      return { data: { list: pages?.[index] ?? [campaign()], count: pages ? pages.flat().length : 1 } };
    } },
    beforeModify: async value => {
      writes.push(clone(value));
      if (onWrite) return onWrite(value);
      return { success: true };
    },
  };
  const route = type === 'keyword' ? 'search' : 'onesite';
  const Magix = { Vframe: { all: () => ({ active: { path: `${route}/campaign-list`, $v: view } }) },
    Router: {}, State: {} };
  const sandbox = vm.createContext({ URL, location: { href: `https://one.alimama.com/index.html#!/manage/${route}` },
    window: { seajs: { cache: { module: { exports: Magix } } } } });
  return { queries, writes, sandbox, submit };
}

const scanInput = (overrides = {}) => ({ type: 'all-site', pageSize: 500, maxPages: 50,
  reportDate: '2026-09-25', isRt: false, expectedShop: '示例店', expectedAccount: '示例店:子账号',
  ...overrides });
const pauseInput = (overrides = {}) => ({ type: 'all-site', id: '101', execute: true,
  expectedShop: '示例店', expectedAccount: '示例店:子账号', expectedName: '精确计划',
  maxRoi: 1.5, minCharge: 30, reportContext: context({ startTime: '2026-09-25', endTime: '2026-09-25' }),
  ...overrides });
const evaluate = async (source, input, env) => clone(await vm.runInContext(
  source.replaceAll('__INPUT__', JSON.stringify(input)), env.sandbox, { timeout: 1000 }));

test('scan pins the requested date and realtime flag while preserving source and attribution', async () => {
  const env = fixture();
  const result = await evaluate(scanSource, scanInput({ reportDate: '2026-09-26', isRt: true }), env);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].roi, 1.234567);
  assert.equal(result.rows[0].charge, 30.0001);
  assert.deepEqual(result.reportContext, context({ startTime: '2026-09-26', endTime: '2026-09-26', isRt: true }));
  assert.deepEqual(env.queries[0].rptQuery.conditionList, [result.reportContext]);
  assert.equal(env.queries[0].campaignId, undefined);
  assert.equal(env.queries[0].campaignName, undefined);
  assert.deepEqual(env.queries[0].statusList, ['start']);
  assert.equal(JSON.stringify(result).includes('fixture-private-csrf'), false);
});

test('invalid report date or missing explicit realtime choice makes no request', async () => {
  for (const patch of [{ reportDate: '2026-02-30' }, { reportDate: '../date' }, { isRt: undefined }]) {
    const env = fixture();
    await assert.rejects(evaluate(scanSource, scanInput(patch), env), /reportDate|isRt/);
    assert.equal(env.queries.length, 0);
  }
});

test('shop and full account identity are checked before the first request', async () => {
  for (const patch of [{ expectedShop: '另一店' }, { expectedAccount: '示例店:其他账号' }]) {
    const env = fixture();
    await assert.rejects(evaluate(scanSource, scanInput(patch), env), /identity does not match/);
    assert.equal(env.queries.length, 0);
  }
});

test('account changes during a request fail immediately instead of reading the next page', async () => {
  const env = fixture({ onQuery: (_params, _index, setAccount) => {
    setAccount('示例店:另一个账号');
    return { data: { list: [campaign()], count: 2 } };
  } });
  await assert.rejects(evaluate(scanSource, scanInput({ pageSize: 1 }), env), /Account identity/);
  assert.equal(env.queries.length, 1);
});

test('pagination reads every exact offset and detects overlapping IDs or incomplete totals', async () => {
  const env = fixture({ pages: [[campaign()], [campaign({ campaignId: '102' })]] });
  const result = await evaluate(scanSource, scanInput({ pageSize: 1 }), env);
  assert.deepEqual(env.queries.map(row => row.offset), [0, 1]);
  assert.deepEqual(result.rows.map(row => row.campaignId), ['101', '102']);
  for (const [fixtureOptions, error] of [
    [{ pages: [[campaign()], [campaign()]] }, /duplicate campaign IDs/],
    [{ onQuery: () => ({ data: { list: [], count: 2 } }) }, /Pagination incomplete/],
    [{ pages: [[campaign()], [campaign({ campaignId: '102' })]] }, /Pagination incomplete/],
  ]) {
    const bad = fixture(fixtureOptions);
    await assert.rejects(evaluate(scanSource, scanInput({ pageSize: 1, maxPages: error.source === 'Pagination incomplete' && fixtureOptions.pages ? 1 : 50 }), bad), error);
  }
});

test('keyword scan uses roi and permits the native undefined attribution defaults', async () => {
  const env = fixture({ type: 'keyword', conditionOverrides: { effectEqual: undefined, unifyType: undefined } });
  const result = await evaluate(scanSource, scanInput({ type: 'keyword' }), env);
  assert.equal(result.rows[0].roi, 1.4);
  assert.equal(result.rows[0].promotionType, '关键词推广');
  assert.equal(result.reportContext.effectEqual, undefined);
});

test('target verification queries exact IDs with both statuses and never counts absence as paused', async () => {
  const env = fixture({ onQuery: () => ({ data: { list: [], count: 0 } }) });
  const result = await evaluate(scanSource, scanInput({ targets: [{ campaignId: '101', campaignName: '精确计划' }] }), env);
  assert.equal(env.queries[0].campaignId, '101');
  assert.deepEqual(env.queries[0].statusList, ['start', 'pause']);
  assert.equal(result.rows[0].outcome, 'unverified');
  assert.equal(result.rows[0].verified, false);
});

test('target verification rejects ignored filters and duplicate requested targets', async () => {
  const targets = [{ campaignId: '101', campaignName: '精确计划' }];
  const ignored = fixture({ pages: [[campaign({ campaignId: '202' })]] });
  await assert.rejects(evaluate(scanSource, scanInput({ targets }), ignored), /unrelated or duplicate/);
  const duplicate = fixture();
  await assert.rejects(evaluate(scanSource, scanInput({ targets: [...targets, ...targets] }), duplicate), /duplicate/);
  assert.equal(duplicate.queries.length, 0);
});

test('pause reads the exact target using scan dates and submits exactly one guarded write', async () => {
  const env = fixture();
  const result = await evaluate(pauseSource, pauseInput(), env);
  assert.equal(env.queries.length, 1);
  assert.equal(env.queries[0].campaignId, '101');
  assert.deepEqual(env.queries[0].rptQuery.conditionList, [pauseInput().reportContext]);
  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].name, 'campaign_updatePart_post');
  assert.equal(env.writes[0].params.campaignList[0].displayStatus, 'pause');
  assert.equal(result.writeAttempted, true);
  assert.equal(result.verified, false);
});

test('pause requires report context and exact full account before any request', async () => {
  for (const patch of [{ reportContext: undefined }, { expectedAccount: '示例店:别人' },
    { reportContext: context({ startTime: '2026-02-30' }) }]) {
    const env = fixture();
    await assert.rejects(evaluate(pauseSource, pauseInput(patch), env), /REPORT_CONTEXT_MISMATCH|Account identity/);
    assert.equal(env.queries.length, 0);
    assert.equal(env.writes.length, 0);
  }
});

test('pause rejects changed or boundary metrics and inactive status without writing', async () => {
  const badCampaigns = [
    campaign({ reportInfoList: [{ retainedRoi: '1.5', charge: '31' }] }),
    campaign({ reportInfoList: [{ retainedRoi: '1.4', charge: '30' }] }),
    campaign({ displayStatus: 'pause', onlineStatus: 0 }),
  ];
  for (const row of badCampaigns) {
    const env = fixture({ pages: [[row]] });
    await assert.rejects(evaluate(pauseSource, pauseInput(), env), /PAUSE_PRECHECK/);
    assert.equal(env.writes.length, 0);
  }
});

test('both promotion scans and exact target reads normalize blank metrics to zero', async () => {
  for (const type of ['all-site', 'keyword']) {
    for (const empty of [null, undefined, '', ' \t\n']) {
      for (const targets of [undefined, [{ campaignId: '101', campaignName: '精确计划' }]]) {
        const report = { retainedRoi: empty, roi: empty, charge: empty };
        const env = fixture({ type, pages: [[campaign({ reportInfoList: [report] })]] });
        const result = await evaluate(scanSource, scanInput({ type, targets }), env);
        assert.equal(result.rows[0].roi, 0);
        assert.equal(result.rows[0].charge, 0);
        assert.equal(env.writes.length, 0);
      }
    }
    const absent = fixture({ type, pages: [[campaign({ reportInfoList: [] })]] });
    const result = await evaluate(scanSource, scanInput({ type }), absent);
    assert.equal(result.rows[0].roi, 0);
    assert.equal(result.rows[0].charge, 0);
  }
});

test('blank selected ROI uses zero and pauses at charge 30.1 in both promotion types', async () => {
  for (const type of ['all-site', 'keyword']) {
    const selectedRoi = type === 'keyword' ? 'roi' : 'retainedRoi';
    for (const empty of [null, undefined, '', ' \t\n']) {
      // The other promotion's ROI must never substitute for the selected field.
      const report = { retainedRoi: 99, roi: 99, charge: '30.1', [selectedRoi]: empty };
      const env = fixture({ type, pages: [[campaign({ reportInfoList: [report] })]] });
      const result = await evaluate(pauseSource, pauseInput({ type }), env);
      assert.equal(env.queries.length, 1);
      assert.equal(env.writes.length, 1);
      assert.equal(env.writes[0].name, 'campaign_updatePart_post');
      assert.equal(env.writes[0].params.campaignList[0].campaignId, '101');
      assert.equal(env.writes[0].params.campaignList[0].displayStatus, 'pause');
      assert.equal(result.writeAttempted, true);
      assert.equal(result.verified, false);
    }
  }
});

test('blank ROI does not pause at the charge boundary or for blank charge', async () => {
  for (const type of ['all-site', 'keyword']) {
    for (const charge of [30, '30', null, undefined, '', ' \t\n']) {
      const report = { retainedRoi: null, roi: null, charge };
      const env = fixture({ type, pages: [[campaign({ reportInfoList: [report] })]] });
      await assert.rejects(evaluate(pauseSource, pauseInput({ type }), env), /PAUSE_PRECHECK:METRICS_CHANGED/);
      assert.equal(env.queries.length, 1);
      assert.equal(env.writes.length, 0);
    }
  }
});

test('nonblank invalid metrics fail scans and pause prechecks without any write', async () => {
  for (const type of ['all-site', 'keyword']) {
    const selectedRoi = type === 'keyword' ? 'roi' : 'retainedRoi';
    for (const invalid of ['N/A', 'NaN', 'Infinity', NaN, Infinity, false, {}, []]) {
      for (const field of [selectedRoi, 'charge']) {
        const report = { retainedRoi: 1, roi: 1, charge: 30.1, [field]: invalid };
        for (const targets of [undefined, [{ campaignId: '101', campaignName: '精确计划' }]]) {
          const scanned = fixture({ type, pages: [[campaign({ reportInfoList: [report] })]] });
          await assert.rejects(evaluate(scanSource, scanInput({ type, targets }), scanned), /Invalid metric:/);
          assert.equal(scanned.writes.length, 0);
        }
        const paused = fixture({ type, pages: [[campaign({ reportInfoList: [report] })]] });
        await assert.rejects(evaluate(pauseSource, pauseInput({ type }), paused), /PAUSE_PRECHECK:INVALID_METRICS/);
        assert.equal(paused.queries.length, 1);
        assert.equal(paused.writes.length, 0);
      }
    }
  }
});

test('pause fails on an account change during precheck and never repeats an uncertain write', async () => {
  const changed = fixture({ onQuery: (_params, _index, setAccount) => {
    setAccount('示例店:其他人');
    return { data: { list: [campaign()], count: 1 } };
  } });
  await assert.rejects(evaluate(pauseSource, pauseInput(), changed), /Account identity/);
  assert.equal(changed.writes.length, 0);
  const uncertain = fixture({ onWrite: () => { throw new Error('response unavailable'); } });
  await assert.rejects(evaluate(pauseSource, pauseInput(), uncertain), /Pause outcome uncertain/);
  assert.equal(uncertain.writes.length, 1);
});

test('readonly pause preview and explicit verification never submit a write', async () => {
  const preview = fixture();
  const result = await evaluate(pauseSource, pauseInput({ execute: false }), preview);
  assert.equal(result.writeAttempted, false);
  assert.equal(preview.writes.length, 0);
  const verify = fixture({ pages: [[campaign({ displayStatus: 'pause', onlineStatus: 0 })]] });
  const checked = await evaluate(pauseSource, pauseInput({ execute: false, verify: true }), verify);
  assert.equal(checked.verified, true);
  assert.equal(verify.writes.length, 0);
});

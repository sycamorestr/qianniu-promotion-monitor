import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// The registry and browser are mocked. These tests never start OpenCLI or perform a write online.
function loadAdapter(name) {
  const registrations = [];
  const source = readFileSync(new URL(`../adapters/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .* from '@jackwener\/opencli\/registry';\r?\n/m, '')
    .replace(/^export /gm, '');
  vm.runInNewContext(source, {
    cli: definition => registrations.push(definition),
    Strategy: { PAGE_FETCH: 'PAGE_FETCH', DOM_STATE: 'DOM_STATE' },
  }, { filename: `${name}.js` });
  assert.equal(registrations.length, 1);
  return registrations[0];
}

const scan = loadAdapter('scan-campaigns');
const pause = loadAdapter('pause-campaign');
const whoami = loadAdapter('whoami');

function campaign(overrides = {}) {
  return {
    campaignId: 'target', campaignName: 'Target campaign',
    displayStatus: 'start', onlineStatus: 1,
    bizCode: 'known-biz', sourceChannel: 'known-source', channelLocation: 'known-location',
    reportInfoList: [{ roi: 1.1, retainedRoi: 1.2, charge: 31 }],
    ...overrides,
  };
}

const reportCondition = {
  sourceList: ['scene', 'campaign_list'],
  adzonePkgIdList: [],
  effectEqual: '15',
  unifyType: 'last_click_by_effect_time',
  startTime: '2026-09-14',
  endTime: '2026-09-14',
  isRt: true,
};

function harness({ rows = [campaign()], shop = 'Example shop', onRead, onWrite, fallbackOnly = false,
  submitParams = { rptQuery: { conditionList: [reportCondition], fields: 'charge' } } } = {}) {
  const state = { rows, shop, reads: [], writes: [], navigation: [], waits: [] };
  const location = { hostname: 'one.alimama.com', href: '' };
  const view = {
    updater: {
      get: key => key === 'user'
        ? { meta: { nickName: `${state.shop}:operator` } }
        : typeof submitParams === 'function' ? submitParams(location) : submitParams,
    },
    requester: {
      campaign_horizontal_findPage_post: async params => {
        state.reads.push(JSON.parse(JSON.stringify(params)));
        if (onRead) return onRead(params, state, location);
        return { data: { list: state.rows.slice(params.offset, params.offset + params.pageSize), count: state.rows.length } };
      },
    },
    beforeModify: async request => {
      state.writes.push(JSON.parse(JSON.stringify(request)));
      if (onWrite) return onWrite(request, state);
      state.rows = state.rows.filter(row => String(row.campaignId) !== String(request.params.campaignList[0].campaignId));
      return { data: { success: true } };
    },
  };
  const Magix = {
    Vframe: { all: () => ({
      allSite: { path: 'onesite/campaign-list', $v: view },
      keyword: { path: 'search/campaign-list', $v: view },
    }) },
    Router: {}, State: {},
  };
  const context = vm.createContext({
    window: { seajs: { cache: { magix: { exports: { default: Magix } } } } },
    location,
    setTimeout: (callback, milliseconds) => { state.waits.push(milliseconds); callback(); },
  });
  const navigate = method => async url => { state.navigation.push({ method, url }); location.href = url; };
  const page = {
    navigate: navigate('navigate'),
    evaluate: script => vm.runInContext(script, context),
  };
  if (!fallbackOnly) page.goto = navigate('goto');
  return { page, state };
}

const executeArgs = overrides => ({
  'promotion-type': 'all-site', 'campaign-id': 'target', execute: true,
  'expected-shop': 'Example shop', 'expected-name': 'Target campaign',
  'max-roi': '1.5', 'min-charge': '30', 'page-size': 1, 'max-pages': 10,
  ...overrides,
});

test('scan uses both active statuses and preserves raw metric precision for decisions', async () => {
  const { page, state } = harness({ rows: [
    campaign({ reportInfoList: [{ retainedRoi: '1.49999', roi: '1.23456', charge: '30.00001' }] }),
    campaign({ campaignId: 'display-only', onlineStatus: 0 }),
    campaign({ campaignId: 'online-only', displayStatus: 'pause' }),
  ] });
  const result = await scan.func(page, { 'page-size': 2 });
  assert.equal(result.length, 3);
  assert.equal(result[0].recordType, 'identity');
  assert.equal(result[1].roi, 1.49999);
  assert.equal(result[2].roi, 1.23456);
  assert.equal(result[1].charge, 30.00001);
  assert.equal(state.navigation.length, 2);
  assert.ok(state.navigation.every(item => item.method === 'goto'));
  assert.deepEqual(state.waits, [4000, 4000]);
  assert.ok(state.reads.every(item => item.statusList.join(',') === 'start'));
  assert.ok(state.reads[0].rptQuery.fields.includes('retainedRoi'));
  assert.ok(state.reads[2].rptQuery.fields.includes('roi'));
  assert.deepEqual(state.reads[0].rptQuery.conditionList, [reportCondition]);
});

test('scan and pause clear retained page filters before reading the complete active list', async () => {
  const submitParams = {
    searchKey: 'campaignNameLike',
    searchValue: 'stale filter',
    queryRuleAuto: '1',
    promotionSceneList: ['stale promotion filter'],
    csrfId: 'csrf-shape',
    loginPointId: 'login-shape',
    statusList: ['pause'],
    mx_bizCode: 'known-mx-biz',
    bizCode: 'known-biz',
    adgroupRequired: true,
    adzoneRequired: false,
    rptQuery: { conditionList: [reportCondition], fields: 'charge' },
  };
  const scanHarness = harness({ submitParams });
  await scan.func(scanHarness.page, {});
  assert.ok(scanHarness.state.reads.every(params => params.statusList.join(',') === 'start'));
  assert.ok(scanHarness.state.reads.every(params => !('searchValue' in params) && !('searchKey' in params)));
  assert.ok(scanHarness.state.reads.every(params => !('promotionSceneList' in params) && !('searchKey' in params)));
  assert.ok(scanHarness.state.reads.every(params => params.queryRuleAuto === '1'
    && params.csrfId === 'csrf-shape' && params.loginPointId === 'login-shape'));
  assert.ok(scanHarness.state.reads.every(params => params.rptQuery.conditionList[0].effectEqual === '15'));

  const pauseHarness = harness({ submitParams });
  await pause.func(pauseHarness.page, executeArgs());
  assert.ok(pauseHarness.state.reads.every(params => !('searchValue' in params) && !('searchKey' in params)));
  assert.ok(pauseHarness.state.reads.every(params => !('promotionSceneList' in params) && !('searchKey' in params)));
  assert.ok(pauseHarness.state.reads.every(params => params.queryRuleAuto === '1'
    && params.csrfId === 'csrf-shape' && params.loginPointId === 'login-shape'));
  assert.ok(pauseHarness.state.reads.every(params => params.rptQuery.conditionList[0].effectEqual === '15'));
});

test('scan rejects missing metrics as null instead of treating them as zero', async () => {
  const { page } = harness({ rows: [campaign({ reportInfoList: [{ retainedRoi: ' ', roi: false, charge: '' }] })] });
  const result = await scan.func(page, {});
  assert.equal(result[1].roi, null);
  assert.equal(result[2].roi, null);
  assert.equal(result[1].charge, null);
});

for (const invalidConditionList of [[], [{}], [null]]) {
  test('scan and pause fail closed when report conditions are not ready', async () => {
    const submitParams = { rptQuery: { conditionList: invalidConditionList, fields: 'charge' } };
    const scanHarness = harness({ submitParams });
    await assert.rejects(scan.func(scanHarness.page, {}), /campaign list is not ready/);
    const pauseHarness = harness({ submitParams });
    await assert.rejects(pause.func(pauseHarness.page, executeArgs()), /Campaign list is not ready/);
  });
}

test('keyword accepts explicit undefined attribution defaults while all-site and partial defaults fail closed', async () => {
  const keywordDefault = { ...reportCondition, effectEqual: undefined, unifyType: undefined };
  const byRoute = location => ({
    rptQuery: {
      conditionList: [location.href.includes('/manage/search') ? keywordDefault : reportCondition],
      fields: 'charge',
    },
  });
  const scanHarness = harness({ submitParams: byRoute });
  const rows = await scan.func(scanHarness.page, {});
  assert.equal(rows.length, 3);
  assert.equal(scanHarness.state.reads.length, 2);
  assert.ok(!('effectEqual' in scanHarness.state.reads[1].rptQuery.conditionList[0]));
  assert.ok(!('unifyType' in scanHarness.state.reads[1].rptQuery.conditionList[0]));

  const pauseHarness = harness({ submitParams: { rptQuery: { conditionList: [keywordDefault], fields: 'charge' } } });
  const result = await pause.func(pauseHarness.page, executeArgs({ 'promotion-type': 'keyword' }));
  assert.equal(result.verified, true);
  assert.equal(pauseHarness.state.writes.length, 1);
  assert.ok(!('effectEqual' in pauseHarness.state.reads[0].rptQuery.conditionList[0]));
  assert.ok(!('unifyType' in pauseHarness.state.reads[0].rptQuery.conditionList[0]));

  const allSiteScanHarness = harness({ submitParams: { rptQuery: { conditionList: [keywordDefault], fields: 'charge' } } });
  await assert.rejects(scan.func(allSiteScanHarness.page, {}), /all-site campaign list is not ready/);
  assert.equal(allSiteScanHarness.state.reads.length, 0);

  const allSitePauseHarness = harness({ submitParams: { rptQuery: { conditionList: [keywordDefault], fields: 'charge' } } });
  await assert.rejects(pause.func(allSitePauseHarness.page, executeArgs()), /Campaign list is not ready/);
  assert.equal(allSitePauseHarness.state.reads.length, 0);
  assert.equal(allSitePauseHarness.state.writes.length, 0);

  const partialDefault = { ...reportCondition, effectEqual: undefined };
  const partialHarness = harness({ submitParams: location => ({
    rptQuery: {
      conditionList: [location.href.includes('/manage/search') ? partialDefault : reportCondition],
      fields: 'charge',
    },
  }) });
  await assert.rejects(scan.func(partialHarness.page, {}), /keyword campaign list is not ready/);
});

for (const [name, response, expected] of [
  ['malformed list', { data: {} }, /data.list/],
  ['missing campaign ID', { data: { list: [{}], count: 1 } }, /without an ID/],
  ['invalid count', { data: { list: [], count: false } }, /invalid data.count/],
  ['short incomplete page', { data: { list: [], count: 2 } }, /Pagination incomplete/],
  ['unknown count at page limit', { data: { list: [campaign()] } }, /Pagination incomplete/],
]) {
  test(`scan fails closed for ${name}`, async () => {
    const { page } = harness({ onRead: () => response });
    await assert.rejects(scan.func(page, { 'page-size': 1, 'max-pages': 1 }), expected);
  });
}

test('scan rejects duplicate IDs from overlapping pages', async () => {
  const { page } = harness({ onRead: () => ({ data: { list: [campaign()], count: 2 } }) });
  await assert.rejects(scan.func(page, { 'page-size': 1 }), /duplicate campaign IDs/);
});

test('scan rejects identity changes within a request', async () => {
  const { page } = harness({ onRead: (params, state) => {
    state.shop = 'Different shop';
    return { data: { list: [], count: 0 } };
  } });
  await assert.rejects(scan.func(page, {}), /identity changed/);
});

test('scan rejects identity changes between promotion pages', async () => {
  const { page, state } = harness({ rows: [] });
  const goto = page.goto;
  page.goto = async url => {
    await goto(url);
    if (url.includes('/manage/search')) state.shop = 'Different shop';
  };
  await assert.rejects(scan.func(page, {}), /identity changed/);
});

test('navigation uses navigate only when goto is unavailable', async () => {
  const { page, state } = harness({ rows: [], fallbackOnly: true });
  await scan.func(page, {});
  await whoami.func(page);
  assert.equal(state.navigation.length, 3);
  assert.ok(state.navigation.every(item => item.method === 'navigate'));
});

test('whoami reads shop identity without duplicate navigation', async () => {
  const { page, state } = harness();
  const result = await whoami.func(page);
  assert.equal(result[0].shopName, 'Example shop');
  assert.equal(result[0].loggedIn, true);
  assert.equal(state.navigation.length, 1);
});

for (const name of ['expected-shop', 'expected-name', 'max-roi', 'min-charge']) {
  test(`pause execute requires ${name} before browser navigation`, async () => {
    const { page, state } = harness();
    await assert.rejects(pause.func(page, executeArgs({ [name]: undefined })), /Execution requires/);
    assert.equal(state.navigation.length, 0);
    assert.equal(state.writes.length, 0);
  });
}

test('pause preview performs no write and returns verified=false', async () => {
  const { page, state } = harness();
  const result = await pause.func(page, { 'promotion-type': 'all-site', 'campaign-id': 'target' });
  assert.equal(result.verified, false);
  assert.equal(result.writeAttempted, false);
  assert.equal(state.writes.length, 0);
});

test('pause finds a later page, writes once, and fully verifies the active list', async () => {
  const { page, state } = harness({ rows: [campaign({ campaignId: 'first' }), campaign()] });
  const result = await pause.func(page, executeArgs());
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.afterStatus, 'not-in-active-list');
  assert.equal(result.campaignId, 'target');
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].name, 'campaign_updatePart_post');
  assert.equal(state.writes[0].params.campaignList[0].displayStatus, 'pause');
  assert.equal(state.writes[0].params.campaignList[0].campaignId, 'target');
  assert.deepEqual(state.reads.map(item => item.offset), [0, 1, 0]);
  assert.deepEqual(state.waits, [4000, 1200]);
  assert.equal(state.navigation.length, 1);
});

for (const [name, overrides, args, expected] of [
  ['shop mismatch', {}, { 'expected-shop': 'Other shop' }, /Shop identity/],
  ['name mismatch', {}, { 'expected-name': 'Other campaign' }, /Campaign name/],
  ['display status paused', { displayStatus: 'pause' }, {}, /AND onlineStatus/],
  ['online status disabled', { onlineStatus: 0 }, {}, /AND onlineStatus/],
  ['ROI at boundary', { reportInfoList: [{ retainedRoi: 1.5, charge: 100 }] }, {}, /Latest campaign metrics/],
  ['charge at boundary', { reportInfoList: [{ retainedRoi: 1, charge: 30 }] }, {}, /Latest campaign metrics/],
  ['missing ROI', { reportInfoList: [{ charge: 100 }] }, {}, /Latest campaign metrics/],
  ['empty charge', { reportInfoList: [{ retainedRoi: 1, charge: '' }] }, {}, /Latest campaign metrics/],
]) {
  test(`pause rejects ${name} without writing`, async () => {
    const { page, state } = harness({ rows: [campaign(overrides)] });
    await assert.rejects(pause.func(page, executeArgs(args)), expected);
    assert.equal(state.writes.length, 0);
  });
}

test('pause uses raw metric precision at strict boundaries', async () => {
  const { page, state } = harness({ rows: [campaign({ reportInfoList: [{ retainedRoi: 1.49999, charge: 30.00001 }] })] });
  const result = await pause.func(page, executeArgs());
  assert.equal(result.verified, true);
  assert.equal(state.writes.length, 1);
});

test('keyword pause uses ROI rather than retained ROI', async () => {
  const { page } = harness({ rows: [campaign({ reportInfoList: [{ retainedRoi: 9, roi: 1, charge: 31 }] })] });
  const result = await pause.func(page, executeArgs({ 'promotion-type': 'keyword' }));
  assert.equal(result.promotionType, '关键词推广');
  assert.equal(result.verified, true);
});

test('pause refuses a shop change between reading and writing', async () => {
  const { page, state } = harness({ onRead: (params, live) => {
    live.shop = 'Other shop';
    return { data: { list: [campaign()], count: 1 } };
  } });
  await assert.rejects(pause.func(page, executeArgs()), /Shop identity/);
  assert.equal(state.writes.length, 0);
});

for (const [name, postResponse, expected] of [
  ['malformed verification response', { data: {} }, /data.list/],
  ['incomplete verification', { data: { list: [], count: 2 } }, /Pagination incomplete/],
  ['unrecognized status', { data: { list: [campaign({ displayStatus: undefined, onlineStatus: undefined })], count: 1 } }, /invalid campaign status/],
  ['unknown inactive status values', { data: { list: [campaign({ displayStatus: 'unexpected', onlineStatus: 99 })], count: 1 } }, /unrecognized inactive campaign status/],
  ['one active status', { data: { list: [campaign({ displayStatus: 'pause', onlineStatus: 1 })], count: 1 } }, /still active/],
]) {
  test(`pause does not report success for ${name}`, async () => {
    const { page, state } = harness({
      onRead: (params, live) => live.writes.length ? postResponse : { data: { list: [campaign()], count: 1 } },
      onWrite: () => ({ data: { success: true } }),
    });
    await assert.rejects(pause.func(page, executeArgs()), expected);
    assert.equal(state.writes.length, 1);
  });
}

test('pause verification searches beyond the first page for a still active target', async () => {
  const { page, state } = harness({ rows: [campaign({ campaignId: 'first' }), campaign()], onWrite: () => ({}) });
  await assert.rejects(pause.func(page, executeArgs()), /still active/);
  assert.deepEqual(state.reads.map(item => item.offset), [0, 1, 0, 1]);
  assert.equal(state.writes.length, 1);
});

test('pause verifies an explicit paused and offline target returned by the active query', async () => {
  const { page } = harness({ onWrite: (request, state) => {
    state.rows = [campaign({ displayStatus: 'pause', onlineStatus: 0 })];
    return {};
  } });
  const result = await pause.func(page, executeArgs());
  assert.equal(result.verified, true);
  assert.equal(result.afterStatus, 'pause');
});

test('pause never retries an uncertain write', async () => {
  const { page, state } = harness({ onWrite: () => { throw new Error('network timeout'); } });
  await assert.rejects(pause.func(page, executeArgs()), /outcome uncertain; do not retry write/);
  assert.equal(state.writes.length, 1);
});

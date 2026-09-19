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
    URL,
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

function harness({ rows = [campaign()], shop = 'Example shop', onRead, onWrite, fallbackOnly = false, initialUrl = '',
  domDialogs = [], submitParams = { rptQuery: { conditionList: [reportCondition], fields: 'charge' } } } = {}) {
  const state = { rows, shop, reads: [], writes: [], navigation: [], waits: [], dialogs: [], keys: [] };
  const location = { hostname: 'one.alimama.com', href: initialUrl };
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
        const selected = params.campaignId === undefined ? state.rows
          : state.rows.filter(row => String(row.campaignId) === params.campaignId);
        return { data: { list: selected.slice(params.offset, params.offset + params.pageSize), count: selected.length } };
      },
    },
    beforeModify: async request => {
      state.writes.push(JSON.parse(JSON.stringify(request)));
      if (onWrite) return onWrite(request, state);
      state.rows = state.rows.map(row => String(row.campaignId) === String(request.params.campaignList[0].campaignId)
        ? { ...row, displayStatus: 'pause', onlineStatus: 0 } : row);
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
    window: {
      seajs: { cache: { magix: { exports: { default: Magix } } } },
      getComputedStyle: element => element.style || {},
    },
    document: { querySelectorAll: () => domDialogs },
    location,
    URL,
    setTimeout: (callback, milliseconds) => { state.waits.push(milliseconds); callback(); },
  });
  const navigate = method => async url => { state.navigation.push({ method, url }); location.href = url; };
  const page = {
    navigate: navigate('navigate'),
    getCurrentUrl: async () => location.href || null,
    handleJavaScriptDialog: async accept => { state.dialogs.push(accept); },
    pressKey: async key => { state.keys.push(key); },
    evaluate: script => vm.runInContext(script, context),
  };
  if (!fallbackOnly) page.goto = navigate('goto');
  return { page, state };
}

function domControl({ text = '', attributes = {}, classes = [], tagName = 'BUTTON', visible = true, disabled = false } = {}) {
  return {
    textContent: text, classList: classes, tagName, disabled, hidden: !visible, clicks: 0,
    style: {},
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null; },
    getClientRects() { return visible ? [{}] : []; },
    click() { this.clicks++; },
  };
}

function domDialog(text, controls, { visible = true, id = '' } = {}) {
  const dialog = {
    id, textContent: text, hidden: !visible, style: {},
    getAttribute: () => null,
    getClientRects: () => visible ? [{}] : [],
    querySelectorAll: () => controls,
  };
  for (const control of controls) control.closest ||= () => dialog;
  return dialog;
}

const executeArgs = overrides => ({
  'promotion-type': 'all-site', 'campaign-id': 'target', execute: true,
  'expected-shop': 'Example shop', 'expected-name': 'Target campaign',
  'max-roi': '1.5', 'min-charge': '30', 'page-size': 1, 'max-pages': 10,
  ...overrides,
});

test('Alimama adapters own navigation and expose a command timeout to OpenCLI', () => {
  for (const adapter of [scan, pause]) {
    assert.equal(adapter.navigateBefore, false);
    assert.deepEqual({ ...adapter.args.find(arg => arg.name === 'timeout') }, {
      name: 'timeout', type: 'int', default: 180, help: 'Maximum seconds for the browser command',
    });
  }
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

test('full scan clears retained filters while pause replaces them with the exact target and both statuses', async () => {
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
  assert.ok(pauseHarness.state.reads.every(params => params.campaignId === 'target' && params.statusList.join(',') === 'start,pause'));
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
  assert.deepEqual(state.dialogs, [false]);
  assert.deepEqual(state.keys, ['Escape']);
});

test('pause clicks only an explicit close control inside a recognized marketing dialog', async () => {
  const unrelatedClose = domControl({ attributes: { 'aria-label': '关闭', role: 'button' } });
  const launch = domControl({ text: '立即投放', classes: ['next-dialog-close'] });
  const fuzzyClose = domControl({ classes: ['dialog-close-offer'] });
  const actualClose = domControl({ classes: ['next-dialog-close'], tagName: 'SPAN' });
  const dialogs = [
    domDialog('普通提醒', [unrelatedClose]),
    domDialog('投放调优 立即投放', [launch, fuzzyClose, actualClose]),
  ];
  const { page, state } = harness({ domDialogs: dialogs });
  const result = await pause.func(page, { 'promotion-type': 'all-site', 'campaign-id': 'target' });
  assert.equal(result.writeAttempted, false);
  assert.equal(actualClose.clicks, 1);
  assert.equal(unrelatedClose.clicks, 0);
  assert.equal(launch.clicks, 0);
  assert.equal(fuzzyClose.clicks, 0);
  assert.equal(state.writes.length, 0);
});

test('pause recognizes 全店模式 but never clicks 立即投放 or hidden close controls', async () => {
  const launch = domControl({ text: '立即投放', attributes: { role: 'button' } });
  const hiddenClose = domControl({ attributes: { 'aria-label': '关闭', role: 'button' }, visible: false });
  const { page, state } = harness({ domDialogs: [domDialog('切换全店模式 立即投放', [launch, hiddenClose])] });
  const result = await pause.func(page, { 'promotion-type': 'all-site', 'campaign-id': 'target' });
  assert.equal(result.writeAttempted, false);
  assert.equal(launch.clicks, 0);
  assert.equal(hiddenClose.clicks, 0);
  assert.equal(state.reads.length, 1);
  assert.equal(state.writes.length, 0);
});

test('pause closes a 全店模式 dialog through an exact accessible close label', async () => {
  const close = domControl({ attributes: { 'aria-label': '关闭', role: 'button' } });
  const { page } = harness({ domDialogs: [domDialog('全店模式介绍', [close])] });
  await pause.func(page, { 'promotion-type': 'all-site', 'campaign-id': 'target' });
  assert.equal(close.clicks, 1);
});

test('scan and pause close the known long-cycle package dialog without clicking its launch action', async () => {
  for (const adapter of [scan, pause]) {
    const launch = domControl({ text: '立即投放' });
    const close = domControl();
    const dialog = domDialog('全新升级 长周期套餐包 投放能力 立即投放', [close, launch], { id: 'wrapper_dlg_364' });
    close.closest = selector => selector === '[id^="cnt_dlg_"]' ? null : dialog;
    launch.closest = selector => selector === '[id^="cnt_dlg_"]' ? {} : dialog;
    const { page } = harness({ domDialogs: [dialog] });
    if (adapter === scan) await adapter.func(page, targetArgs());
    else await adapter.func(page, { 'promotion-type': 'all-site', 'campaign-id': 'target' });
    assert.equal(close.clicks, 1);
    assert.equal(launch.clicks, 0);
  }
});

test('scan and pause wait for a current report context instead of failing on an early stale view', async () => {
  for (const adapter of [scan, pause]) {
    let reads = 0;
    const submitParams = () => ++reads < 3
      ? { rptQuery: { conditionList: [{}], fields: 'charge' } }
      : { rptQuery: { conditionList: [reportCondition], fields: 'charge' } };
    const { page, state } = harness({ submitParams });
    if (adapter === scan) await adapter.func(page, targetArgs());
    else await adapter.func(page, { 'promotion-type': 'all-site', 'campaign-id': 'target' });
    assert.deepEqual(state.waits, [4000, 500, 500]);
  }
});

test('pause reuses an exact current route instead of navigating the persistent tab again', async () => {
  const { page, state } = harness({ initialUrl: 'https://one.alimama.com/index.html#!/manage/onesite?from=recovery' });
  await pause.func(page, { 'promotion-type': 'all-site', 'campaign-id': 'target' });
  assert.equal(state.navigation.length, 0);
  assert.equal(state.reads.length, 1);
});

test('pause navigates normally when the bridge cannot read the current URL', async () => {
  const { page, state } = harness();
  page.getCurrentUrl = async () => { throw new Error('transient bridge read failure'); };
  const result = await pause.func(page, { 'promotion-type': 'all-site', 'campaign-id': 'target' });
  assert.equal(result.writeAttempted, false);
  assert.deepEqual(state.navigation, [{
    method: 'goto', url: 'https://one.alimama.com/index.html#!/manage/onesite',
  }]);
  assert.equal(state.reads.length, 1);
  assert.equal(state.writes.length, 0);
});

test('pause does not accept a lookalike host or route when deciding to skip navigation', async () => {
  for (const initialUrl of [
    'https://one.alimama.com.evil.example/index.html#!/manage/onesite',
    'https://one.alimama.com/index.html#!/manage/onesite-other',
    'https://one.alimama.com/index.html#!/manage/onesite/create',
  ]) {
    const { page, state } = harness({ initialUrl });
    await pause.func(page, { 'promotion-type': 'all-site', 'campaign-id': 'target' });
    assert.equal(state.navigation.length, 1);
    assert.deepEqual(state.navigation[0], {
      method: 'goto', url: 'https://one.alimama.com/index.html#!/manage/onesite',
    });
  }
});

test('pause queries only its exact ID before and after one write, without traversing unrelated campaigns', async () => {
  const { page, state } = harness({ rows: [campaign({ campaignId: 'first' }), campaign()] });
  const result = await pause.func(page, executeArgs());
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.afterStatus, 'pause');
  assert.equal(result.campaignId, 'target');
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].name, 'campaign_updatePart_post');
  assert.equal(state.writes[0].params.campaignList[0].displayStatus, 'pause');
  assert.equal(state.writes[0].params.campaignList[0].campaignId, 'target');
  assert.deepEqual(state.reads.map(item => item.offset), [0, 0]);
  assert.ok(state.reads.every(item => item.campaignId === 'target' && item.pageSize === 2));
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
  ['incomplete verification', { data: { list: [], count: 2 } }, /Target query count/],
  ['missing target', { data: { list: [], count: 0 } }, /status remains unverified/],
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

test('pause verification checks the exact target and detects that it remains active', async () => {
  const { page, state } = harness({ rows: [campaign({ campaignId: 'first' }), campaign()], onWrite: () => ({}) });
  await assert.rejects(pause.func(page, executeArgs()), /still active/);
  assert.deepEqual(state.reads.map(item => item.offset), [0, 0]);
  assert.ok(state.reads.every(item => item.campaignId === 'target'));
  assert.equal(state.writes.length, 1);
});

test('pause verifies an explicit paused and offline target returned by the target query', async () => {
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

const targetArgs = (targets = [{ promotionType: '全站推', campaignId: 'target', campaignName: 'Target campaign' }]) => ({ targets: JSON.stringify(targets) });

test('target verification queries only specified IDs and never navigates an unrelated promotion page', async () => {
  const { page, state } = harness({ rows: [campaign({ campaignId: 'unrelated' }), campaign(),
    campaign({ campaignId: 'paused', campaignName: 'Paused campaign', displayStatus: 'pause', onlineStatus: 0 })] });
  const result = await scan.func(page, targetArgs([
    { promotionType: '全站推', campaignId: 'target', campaignName: 'Target campaign' },
    { promotionType: '全站推', campaignId: 'paused', campaignName: 'Paused campaign' },
  ]));
  assert.equal(state.navigation.length, 1);
  assert.match(state.navigation[0].url, /manage\/onesite/);
  assert.deepEqual(state.reads.map(params => params.campaignId), ['target', 'paused']);
  assert.ok(state.reads.every(params => params.offset === 0 && params.pageSize === 2 && params.statusList.join(',') === 'start,pause'));
  assert.equal(result.length, 3);
  assert.equal(result[0].recordType, 'identity');
  assert.equal(result[1].outcome, 'active');
  assert.equal(result[2].outcome, 'inactive');
  assert.ok(result.slice(1).every(row => row.recordType === 'verification' && row.verified));
  assert.equal(result[1].roi, 1.2);
  assert.ok(result.every(row => row.campaignId !== 'unrelated'));
  assert.equal(state.writes.length, 0);
});

test('keyword-only target verification visits only keyword and uses keyword ROI', async () => {
  const { page, state } = harness();
  const result = await scan.func(page, targetArgs([{ promotionType: '关键词推广', campaignId: 'target', campaignName: 'Target campaign' }]));
  assert.equal(state.navigation.length, 1);
  assert.match(state.navigation[0].url, /manage\/search/);
  assert.equal(state.reads.length, 1);
  assert.equal(result[1].promotionType, '关键词推广');
  assert.equal(result[1].roi, 1.1);
});

test('missing and ambiguous target statuses always return an explicit unverified record', async () => {
  for (const rows of [[], [campaign({ displayStatus: 'pause', onlineStatus: 1 })],
    [campaign({ campaignName: 'Different campaign' })], [campaign({ displayStatus: 'unexpected', onlineStatus: 0 })]]) {
    const { page } = harness({ rows });
    const result = await scan.func(page, targetArgs());
    assert.equal(result.length, 2);
    assert.equal(result[1].recordType, 'verification');
    assert.equal(result[1].campaignId, 'target');
    assert.equal(result[1].outcome, 'unverified');
    assert.equal(result[1].verified, false);
  }
});

test('target scan and pause reject ignored filters, duplicate IDs and incomplete counts', async () => {
  for (const response of [
    { data: { list: [campaign({ campaignId: 'unrelated' })], count: 1 } },
    { data: { list: [campaign(), campaign({ campaignId: 'unrelated' })], count: 2 } },
    { data: { list: [campaign(), campaign()], count: 2 } },
    { data: { list: [campaign()], count: 100 } },
  ]) {
    const scanHarness = harness({ onRead: () => response });
    await assert.rejects(scan.func(scanHarness.page, targetArgs()), /Target query/);
    assert.equal(scanHarness.state.reads.length, 1);
    const pauseHarness = harness({ onRead: () => response });
    await assert.rejects(pause.func(pauseHarness.page, executeArgs()), /Target query/);
    assert.equal(pauseHarness.state.reads.length, 1);
    assert.equal(pauseHarness.state.writes.length, 0);
  }
});

test('pause rejects an ignored filter after writing rather than accepting a different paused plan', async () => {
  const { page, state } = harness({
    onRead: (params, live) => ({ data: { list: live.writes.length
      ? [campaign({ campaignId: 'other', displayStatus: 'pause', onlineStatus: 0 })] : [campaign()], count: 1 } }),
  });
  await assert.rejects(pause.func(page, executeArgs()), /unrelated or duplicate campaign IDs/);
  assert.equal(state.writes.length, 1);
});

test('target verification preserves identity checks within and across requested types', async () => {
  const changingRead = harness({ onRead: (_params, state) => {
    state.shop = 'Other shop';
    return { data: { list: [campaign()], count: 1 } };
  } });
  await assert.rejects(scan.func(changingRead.page, targetArgs()), /identity changed/);
  const { page, state } = harness();
  const goto = page.goto;
  page.goto = async url => { await goto(url); if (url.includes('/manage/search')) state.shop = 'Other shop'; };
  await assert.rejects(scan.func(page, targetArgs([
    { promotionType: '全站推', campaignId: 'target', campaignName: 'Target campaign' },
    { promotionType: '关键词推广', campaignId: 'target', campaignName: 'Target campaign' },
  ])), /identity changed/);
});

test('invalid targets fail before browser navigation', async () => {
  for (const targets of ['invalid JSON', '[]', '{}', '[null]', '[{"promotionType":"全站推","campaignId":"target"}]',
    JSON.stringify([{ promotionType: '全站推', campaignId: 'target', campaignName: 'Target campaign' },
      { promotionType: '全站推', campaignId: 'target', campaignName: 'Target campaign' }])]) {
    const { page, state } = harness();
    await assert.rejects(scan.func(page, { targets }), /targets/);
    assert.equal(state.navigation.length, 0);
    assert.equal(state.reads.length, 0);
  }
});

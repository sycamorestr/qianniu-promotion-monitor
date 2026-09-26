import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise only the host-side page lifecycle. No browser or campaign API is used.
function loadPause() {
  const registrations = [];
  const errors = [];
  const source = readFileSync(new URL('../adapters/pause-campaign.js', import.meta.url), 'utf8')
    .replace(/^import .* from '@jackwener\/opencli\/registry';\r?\n/m, '')
    .replace(/^export /gm, '');
  vm.runInNewContext(source, {
    cli: definition => registrations.push(definition),
    Strategy: { PAGE_FETCH: 'PAGE_FETCH' },
    URL,
    setTimeout: callback => callback(),
    console: { error: (...values) => errors.push(values.join(' ')) },
  }, { filename: 'pause-campaign.js' });
  assert.equal(registrations.length, 1);
  return { pause: registrations[0], errors };
}

const args = {
  'promotion-type': 'all-site', 'campaign-id': 'target', execute: true,
  'expected-shop': 'Example shop', 'expected-name': 'Target campaign',
  'max-roi': '1.5', 'min-charge': '30',
};
const route = 'https://one.alimama.com/index.html#!/manage/onesite';

function session(initial = [], { listing, gotoError, closeError, keepClosed = false, evaluateError } = {}) {
  const state = {
    tabs: initial.map(tab => ({ ...tab })),
    userTabs: [{ page: 'user-page', url: 'https://one.alimama.com/index.html#!/manage/search' }],
    active: initial[0]?.page,
    lease: true,
    calls: [],
    evaluations: [],
    nextId: 0,
    listings: 0,
  };
  const page = {
    tabs: async () => {
      state.calls.push(['tabs']);
      state.listings++;
      if (listing !== undefined && state.listings === 1) return listing;
      // newTab replaces the extension session's preferred tab. Older physical
      // tabs remain open but cease to be part of this command's tab listing.
      return state.tabs.filter(tab => state.listings === 1 || tab.page === state.active)
        .map(tab => ({ ...tab }));
    },
    newTab: async url => {
      const target = `new-${++state.nextId}`;
      state.calls.push(['newTab', url, target]);
      state.tabs.push({ page: target, url });
      state.active = target;
      return target;
    },
    setActivePage: target => { state.calls.push(['setActivePage', target]); state.active = target; },
    goto: async (url, options) => {
      state.calls.push(['goto', url, { ...options }]);
      if (gotoError) throw gotoError;
      const current = state.tabs.find(tab => tab.page === state.active);
      assert.ok(current, 'navigation must target an existing session tab');
      current.url = url;
    },
    closeTab: async target => {
      state.calls.push(['closeTab', target]);
      if (closeError) throw closeError;
      if (!keepClosed) state.tabs = state.tabs.filter(tab => tab.page !== target);
    },
    evaluate: async script => {
      const options = JSON.parse(script.slice(script.lastIndexOf(')(') + 2, -1));
      state.evaluations.push(options);
      if (evaluateError) throw evaluateError;
      return {
        ok: true, shopName: 'Example shop', campaignId: 'target', campaignName: 'Target campaign',
        promotionType: '全站推', beforeStatus: options.verify ? 'pause' : 'start',
        afterStatus: options.verify ? 'pause' : null,
        writeAttempted: options.execute || options.verify || false,
        verified: options.verify || false,
      };
    },
  };
  return { page, state };
}

test('pause reuses the sole exact blank tab and verifies its removal', async () => {
  const { pause } = loadPause();
  const { page, state } = session([{ page: 'trace-blank', url: 'about:blank' }]);
  const result = await pause.func(page, args);
  assert.equal(result.verified, true);
  assert.equal(result.cleanup.reusedBlank, true);
  assert.equal(result.cleanup.pageClosed, true);
  assert.equal(state.calls.some(call => call[0] === 'newTab'), false);
  assert.deepEqual(state.calls.filter(call => call[0] === 'goto'), [['goto', route, { waitUntil: 'none' }]]);
  assert.deepEqual(state.calls.filter(call => call[0] === 'closeTab'), [['closeTab', 'trace-blank']]);
  assert.equal(state.calls.at(-1)[0], 'tabs');
  assert.equal(state.evaluations.length, 2);
  assert.equal(state.tabs.length, 0);
});

for (const [name, tabs] of [
  ['an existing campaign page', [{ page: 'existing', url: route }]],
  ['two blank pages', [{ page: 'blank-1', url: 'about:blank' }, { page: 'blank-2', url: 'about:blank' }]],
  ['blank and campaign pages', [{ page: 'blank', url: 'about:blank' }, { page: 'existing', url: route }]],
  ['a blank URL with a fragment', [{ page: 'fragment', url: 'about:blank#user-content' }]],
  ['a lookalike blank URL', [{ page: 'lookalike', url: 'https://example.test/about:blank' }]],
  ['no session pages', []],
]) {
  test(`pause preserves ${name} and closes only its new page`, async () => {
    const { pause } = loadPause();
    const { page, state } = session(tabs);
    const initialTabs = structuredClone(state.tabs);
    const userTabs = structuredClone(state.userTabs);
    const result = await pause.func(page, args);
    assert.equal(result.cleanup.reusedBlank, false);
    assert.equal(result.cleanup.pageClosed, true);
    assert.deepEqual(state.tabs, initialTabs);
    assert.deepEqual(state.userTabs, userTabs);
    assert.equal(state.calls.some(call => call[0] === 'goto'), false);
    assert.deepEqual(state.calls.filter(call => call[0] === 'newTab'), [['newTab', route, 'new-1']]);
    assert.deepEqual(state.calls.filter(call => call[0] === 'closeTab'), [['closeTab', 'new-1']]);
  });
}

for (const [name, listing] of [
  ['missing page ID', [{ url: 'about:blank' }]],
  ['empty page ID', [{ page: '', url: 'about:blank' }]],
  ['whitespace page ID', [{ page: '   ', url: 'about:blank' }]],
  ['numeric page ID', [{ page: 42, url: 'about:blank' }]],
  ['null entry', [null]],
]) {
  test(`pause does not reuse an ambiguous blank with ${name}`, async () => {
    const { pause } = loadPause();
    const { page, state } = session([], { listing });
    const result = await pause.func(page, args);
    assert.equal(result.cleanup.reusedBlank, false);
    assert.equal(result.cleanup.pageClosed, true);
    assert.deepEqual(state.calls.filter(call => call[0] === 'newTab'), [['newTab', route, 'new-1']]);
    assert.deepEqual(state.calls.filter(call => call[0] === 'closeTab'), [['closeTab', 'new-1']]);
  });
}

test('pause rejects a malformed session listing before navigation', async () => {
  const { pause } = loadPause();
  const { page, state } = session([], { listing: { page: 'blank', url: 'about:blank' } });
  await assert.rejects(pause.func(page, args), /did not return the session pages/);
  assert.deepEqual(state.calls, [['tabs']]);
  assert.equal(state.evaluations.length, 0);
});

test('pause preserves a blank when goto is unavailable and uses a new page', async () => {
  const { pause } = loadPause();
  const { page, state } = session([{ page: 'trace-blank', url: 'about:blank' }]);
  delete page.goto;
  const result = await pause.func(page, args);
  assert.equal(result.cleanup.reusedBlank, false);
  assert.equal(result.cleanup.pageClosed, true);
  assert.deepEqual(state.tabs, [{ page: 'trace-blank', url: 'about:blank' }]);
  assert.deepEqual(state.calls.filter(call => call[0] === 'newTab'), [['newTab', route, 'new-1']]);
  assert.deepEqual(state.calls.filter(call => call[0] === 'closeTab'), [['closeTab', 'new-1']]);
});

test('repeated trace and pause cycles retain one physical blank instead of accumulating extras', async () => {
  const { pause } = loadPause();
  const { page, state } = session();
  const physicalTabs = [{ page: 'user-page', url: route }];
  const userTab = structuredClone(physicalTabs[0]);
  let preferred;
  let nextId = 0;
  let createdByPause = 0;
  let releases = 0;
  const acquireTrace = () => {
    // The extension may reuse a previously released blank for a new trace.
    preferred = physicalTabs.find(tab => tab.page !== 'user-page' && tab.url === 'about:blank');
    if (!preferred) {
      preferred = { page: `physical-${++nextId}`, url: 'about:blank' };
      physicalTabs.push(preferred);
    }
  };
  page.tabs = async () => preferred ? [{ ...preferred }] : [];
  page.newTab = async url => {
    createdByPause++;
    preferred = { page: `physical-${++nextId}`, url };
    physicalTabs.push(preferred);
    return preferred.page;
  };
  page.setActivePage = target => assert.equal(target, preferred.page);
  page.goto = async (url, options) => {
    assert.equal(options.waitUntil, 'none');
    preferred.url = url;
  };
  page.closeTab = async target => {
    assert.equal(target, preferred.page);
    // Bridge 1.0.23 releases the lease and blanks the physical page; it does
    // not close the page. A later tabs() therefore returns an empty session.
    preferred.url = 'about:blank';
    preferred = undefined;
    releases++;
  };
  for (let run = 0; run < 6; run++) {
    acquireTrace();
    assert.equal(physicalTabs.filter(tab => tab.url === 'about:blank').length, 1);
    const result = await pause.func(page, args);
    assert.equal(result.verified, true);
    assert.equal(result.cleanup.reusedBlank, true);
    assert.equal(result.cleanup.pageClosed, true);
    assert.deepEqual(await page.tabs(), []);
    assert.equal(physicalTabs.filter(tab => tab.url === 'about:blank').length, 1);
    assert.equal(physicalTabs.length, 2);
    assert.deepEqual(physicalTabs[0], userTab);
  }
  assert.equal(createdByPause, 0);
  assert.equal(releases, 6);
  assert.equal(state.evaluations.length, 12);
});

test('pause closes a reused blank even when its initial navigation fails', async () => {
  const { pause } = loadPause();
  const failure = new Error('initial navigation failed');
  const { page, state } = session([{ page: 'trace-blank', url: 'about:blank' }], { gotoError: failure });
  await assert.rejects(pause.func(page, args), error => error === failure);
  assert.deepEqual(state.calls.filter(call => call[0] === 'closeTab'), [['closeTab', 'trace-blank']]);
  assert.equal(state.calls.at(-1)[0], 'tabs');
  assert.equal(state.evaluations.length, 0);
  assert.equal(state.tabs.length, 0);
});

test('a successful close response is insufficient while the target is still listed', async () => {
  const { pause } = loadPause();
  const { page, state } = session([{ page: 'trace-blank', url: 'about:blank' }], { keepClosed: true });
  const result = await pause.func(page, args);
  assert.equal(result.verified, true);
  assert.equal(result.cleanup.reusedBlank, true);
  assert.equal(result.cleanup.pageClosed, false);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.calls.at(-1)[0], 'tabs');
});

test('pause refuses cleanup when the current session target changes', async () => {
  const { pause } = loadPause();
  const { page, state } = session([{ page: 'trace-blank', url: 'about:blank' }]);
  const tabs = page.tabs;
  let calls = 0;
  page.tabs = async () => ++calls === 1 ? tabs() : [{ page: 'unrelated-target', url: route }];
  const result = await pause.func(page, args);
  assert.equal(result.verified, true);
  assert.equal(result.cleanup.pageClosed, false);
  assert.equal(state.calls.some(call => call[0] === 'closeTab'), false);
});

test('cleanup failure preserves a verified result without leaking its error details', async () => {
  const { pause, errors } = loadPause();
  const { page } = session([{ page: 'trace-blank', url: 'about:blank' }], {
    closeError: new Error('private cleanup details'),
  });
  const result = await pause.func(page, args);
  assert.equal(result.verified, true);
  assert.equal(result.cleanup.pageClosed, false);
  assert.doesNotMatch(JSON.stringify(result) + errors.join('\n'), /private cleanup details/);
});

test('cleanup failure preserves the original business error', async () => {
  const { pause, errors } = loadPause();
  const failure = new Error('[PAUSE_PRECHECK:METRICS_CHANGED] Original business error');
  const { page, state } = session([{ page: 'trace-blank', url: 'about:blank' }], {
    closeError: new Error('private cleanup details'), evaluateError: failure,
  });
  await assert.rejects(pause.func(page, args), error => error === failure);
  assert.deepEqual(state.calls.filter(call => call[0] === 'closeTab'), [['closeTab', 'trace-blank']]);
  assert.equal(state.evaluations.length, 1);
  assert.doesNotMatch(errors.join('\n'), /private cleanup details/);
});

test('pause requires session tab enumeration before doing any browser work', async () => {
  const { pause } = loadPause();
  const { page, state } = session([{ page: 'trace-blank', url: 'about:blank' }]);
  delete page.tabs;
  await assert.rejects(pause.func(page, args), /lifecycle API is unavailable/);
  assert.deepEqual(state.calls, []);
  assert.equal(state.evaluations.length, 0);
});

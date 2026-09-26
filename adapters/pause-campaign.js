import { cli, Strategy } from '@jackwener/opencli/registry';

// Executed in the authenticated page; no external module closures are available here.
export async function pauseCampaignPage(options) {
  const { type, id, execute, verify, expectedShop, expectedName, maxRoi, minCharge, reportContext } = options;
  const route = type === 'keyword' ? '/manage/search' : '/manage/onesite';
  const onRoute = href => {
    try {
      const pageUrl = new URL(href);
      if (pageUrl.protocol !== 'https:' || pageUrl.hostname !== 'one.alimama.com' || !pageUrl.hash.startsWith('#!')) return false;
      const virtualUrl = new URL(pageUrl.hash.slice(2), pageUrl.origin);
      return virtualUrl.pathname.replace(/\/$/, '') === route;
    } catch { return false; }
  };
  const assertRoute = () => {
    if (/(?:\/login|\/signin|passport)/i.test(String(location.href || ''))) {
      throw new Error('Authentication required: Alimama login page is active');
    }
    if (!onRoute(location.href)) throw new Error('Not on requested Alimama page');
  };
  assertRoute();
  // Close only the known marketing overlays. Broad text/button matching could trigger
  // the overlay's primary action, so every clickable control must carry explicit close semantics.
  const dismissKnownMarketingOverlay = () => {
    try {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
      const dialogSelector = '[role="dialog"],[aria-modal="true"],.mx-dialog,.next-dialog,.ant-modal,[id^="wrapper_dlg_"]';
      const controlSelector = [
        'button', '[role="button"]', '[aria-label]', '[title]', '[data-role="close"]', '[data-action="close"]',
        '.mx-dialog-close', '.next-dialog-close', '.ant-modal-close', '.dialog-close', '.modal-close', '.icon-close',
      ].join(',');
      const closeClasses = new Set(['mx-dialog-close', 'next-dialog-close', 'ant-modal-close',
        'dialog-close', 'modal-close', 'icon-close', 'close']);
      const closeLabels = new Set(['关闭', '关闭弹窗', '关闭窗口', 'close']);
      const closeGlyphs = new Set(['×', '✕', '✖', 'x']);
      const normalize = value => String(value || '').replace(/\s+/g, '').toLowerCase();
      const visible = element => {
        if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
        const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(element) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0'
            || style.pointerEvents === 'none')) return false;
        const rects = element.getClientRects?.();
        return !rects || rects.length > 0;
      };
      for (const dialog of document.querySelectorAll(dialogSelector)) {
        const dialogText = normalize(dialog.textContent);
        const recognized = dialogText.includes('投放调优') || dialogText.includes('全店模式')
          || dialogText.includes('长周期套餐包');
        if (!visible(dialog) || !recognized) continue;
        for (const control of dialog.querySelectorAll(controlSelector)) {
          if (!visible(control) || control.disabled || control.getAttribute?.('aria-disabled') === 'true'
              || typeof control.closest !== 'function' || control.closest(dialogSelector) !== dialog) continue;
          const text = normalize(control.textContent);
          const label = normalize(control.getAttribute?.('aria-label'));
          const title = normalize(control.getAttribute?.('title'));
          if ([text, label, title].some(value => value.includes('立即投放'))) continue;
          const classClose = Array.from(control.classList || []).some(name => closeClasses.has(name));
          const dataClose = ['close', 'dismiss'].includes(normalize(control.getAttribute?.('data-role')))
            || ['close', 'dismiss'].includes(normalize(control.getAttribute?.('data-action')));
          const platformHeaderClose = String(dialog.id || '').startsWith('wrapper_dlg_')
            && String(control.tagName || '').toUpperCase() === 'BUTTON'
            && !control.closest('[id^="cnt_dlg_"]');
          const semanticClose = closeLabels.has(text) || closeLabels.has(label) || closeLabels.has(title)
            || closeGlyphs.has(text) || classClose || dataClose || platformHeaderClose;
          const clickable = String(control.tagName || '').toUpperCase() === 'BUTTON'
            || normalize(control.getAttribute?.('role')) === 'button' || classClose || dataClose;
          if (!semanticClose || !clickable || typeof control.click !== 'function') continue;
          control.click();
          return;
        }
      }
    } catch { /* Marketing-overlay dismissal is best effort; write guards remain authoritative. */ }
  };
  const pattern = type === 'keyword' ? /search\/campaign-list/ : /onesite\/campaign-list/;
  const reportValue = value => (typeof value === 'string' || typeof value === 'number')
    && String(value).trim() !== '';
  const attributionReady = item => (reportValue(item?.effectEqual) && reportValue(item?.unifyType))
    || (type === 'keyword'
      && Object.prototype.hasOwnProperty.call(item || {}, 'effectEqual')
      && Object.prototype.hasOwnProperty.call(item || {}, 'unifyType')
      && item.effectEqual === undefined && item.unifyType === undefined);
  const reportReady = conditionList => Array.isArray(conditionList) && conditionList.length === 1
    && !conditionList.some(item => !item || typeof item !== 'object' || Array.isArray(item) || !Object.keys(item).length
        || !Array.isArray(item.sourceList) || !item.sourceList.length
        || item.sourceList.some(value => typeof value !== 'string' || !value.trim())
        || !Array.isArray(item.adzonePkgIdList)
        || !attributionReady(item)
        || typeof item.startTime !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.startTime)
        || typeof item.endTime !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.endTime)
        || typeof item.isRt !== 'boolean'
      );
  let view, api, submit;
  {
    assertRoute();
    dismissKnownMarketingOverlay();
    let Magix;
    for (const entry of Object.values(window.seajs?.cache || {})) {
      const exported = entry?.exports;
      const candidate = exported?.default?.Vframe ? exported.default : exported;
      if (candidate?.Vframe && candidate?.Router && candidate?.State) {
        Magix = candidate;
        break;
      }
    }
    const frames = Magix ? Object.values(Magix.Vframe.all()).filter(item => pattern.test(item.path || '')).reverse() : [];
    for (const frame of frames) {
      const candidateView = frame?.$v;
      const candidateApi = candidateView?.requester?.campaign_horizontal_findPage_post;
      const candidateSubmit = candidateView?.updater?.get('submitParams');
      if (typeof candidateApi === 'function' && reportReady(candidateSubmit?.rptQuery?.conditionList)) {
        view = candidateView;
        api = candidateApi;
        submit = candidateSubmit;
        break;
      }
    }
  }
  if (!view) throw new Error('Campaign list is not ready');
  const identity = () => {
    assertRoute();
    const nickName = String(view.updater.get('user')?.meta?.nickName || '');
    const shopName = nickName.split(/[:：]/)[0].trim();
    if (!shopName) throw new Error('Logged-in shop identity is unavailable');
    if (expectedShop !== undefined && shopName !== expectedShop) throw new Error('Shop identity does not match expected-shop');
    return shopName;
  };
  const shopName = identity();
  const base = {
    orderField: '',
    orderBy: '',
    adgroupRequired: submit.adgroupRequired,
    adzoneRequired: submit.adzoneRequired,
    queryRuleAuto: submit.queryRuleAuto,
    mx_bizCode: submit.mx_bizCode,
    bizCode: submit.bizCode,
    csrfId: submit.csrfId,
    loginPointId: submit.loginPointId,
    statusList: ['start', 'pause'],
    rptQuery: JSON.parse(JSON.stringify(submit.rptQuery)),
  };
  const fields = String(base.rptQuery.fields || '').split(',').filter(Boolean);
  for (const field of type === 'keyword' ? ['roi', 'charge'] : ['retainedRoi', 'charge']) {
    if (!fields.includes(field)) fields.push(field);
  }
  base.rptQuery.fields = fields.join(',');
  if (reportContext !== undefined) {
    // JSON omits the keyword page's explicit undefined attribution defaults.
    const context = { effectEqual: undefined, unifyType: undefined, ...reportContext };
    if (!reportReady([context])) throw new Error('[PAUSE_PRECHECK:REPORT_CONTEXT_MISMATCH] Invalid scan report context');
    base.rptQuery.conditionList = [context];
  }

  // Native onebp mxSearch(searchKey=campaignId) is converted by mxSetParams into this exact field.
  // Never infer a successful pause from a missing target or an API that ignores this filter.
  const readTarget = async () => {
    const response = await api({ ...JSON.parse(JSON.stringify(base)), campaignId: id, offset: 0, pageSize: 2 });
    const data = response?.data;
    if (!Array.isArray(data?.list)) throw new Error('Target query did not return data.list');
    if (data.list.length > 1 || data.list.some(row => !row || String(row.campaignId) !== id)) {
      throw new Error('Target query returned unrelated or duplicate campaign IDs');
    }
    if (data.count !== undefined && data.count !== null) {
      const count = Number(data.count);
      if (!['string', 'number'].includes(typeof data.count) || String(data.count).trim() === ''
          || !Number.isSafeInteger(count) || count !== data.list.length) throw new Error('Target query count does not match exact result');
    }
    if (!data.list.length) throw new Error('campaign-id not found in target query; status remains unverified');
    return data.list[0];
  };
  const campaign = await readTarget();
  if (identity() !== shopName) throw new Error('Shop identity changed before write');
  if (expectedName !== undefined && campaign.campaignName !== expectedName) {
    throw new Error('Campaign name does not match expected-name');
  }
  const result = {
    ok: true,
    shopName,
    promotionType: type === 'keyword' ? '关键词推广' : '全站推',
    campaignId: id,
    campaignName: campaign.campaignName || '',
    beforeStatus: campaign.displayStatus || String(campaign.onlineStatus),
    afterStatus: null,
    writeAttempted: false,
    verified: false,
    message: 'dry-run: no write performed',
  };
  if (verify) {
    if (typeof campaign.displayStatus !== 'string' || !campaign.displayStatus
        || typeof campaign.onlineStatus !== 'number' || !Number.isFinite(campaign.onlineStatus)) {
      throw new Error('API returned invalid campaign status during verification');
    }
    if (campaign.displayStatus === 'start' || campaign.onlineStatus === 1) throw new Error('Campaign is still active');
    if (campaign.displayStatus !== 'pause' || campaign.onlineStatus !== 0) {
      throw new Error('API returned an unrecognized inactive campaign status');
    }
    return { ...result, afterStatus: 'pause', writeAttempted: true, verified: true, message: 'paused and verified' };
  }
  if (!execute) return result;
  // Recheck every guard inside the page immediately before the only write call.
  if (!expectedShop || !expectedName || !Number.isFinite(maxRoi) || !Number.isFinite(minCharge)) {
    throw new Error('Execution requires expected-shop, expected-name, max-roi, and min-charge');
  }
  if (campaign.displayStatus !== 'start' || campaign.onlineStatus !== 1) {
    throw new Error('[PAUSE_PRECHECK:TARGET_NOT_ACTIVE] Campaign must have displayStatus=start AND onlineStatus=1');
  }
  const metric = value => {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const report = campaign.reportInfoList?.[0] || {};
  const roi = metric(type === 'keyword' ? report.roi : report.retainedRoi);
  const charge = metric(report.charge);
  if (roi === null || charge === null || !(roi < maxRoi && charge > minCharge)) {
    throw new Error('[PAUSE_PRECHECK:METRICS_CHANGED] Latest campaign metrics no longer satisfy ROI < max-roi and charge > min-charge');
  }
  if (typeof view.beforeModify !== 'function') throw new Error('Campaign update API is unavailable');
  identity();
  const params = {
    bizCode: campaign.bizCode,
    sourceChannel: campaign.sourceChannel,
    channelLocation: campaign.channelLocation,
    campaignList: [{
      sourceChannel: campaign.sourceChannel,
      channelLocation: campaign.channelLocation,
      campaignId: campaign.campaignId,
      displayStatus: 'pause',
    }],
  };
  result.writeAttempted = true;
  try {
    // Never retry this call: a rejected/timeout response may still have changed the server.
    await view.beforeModify({ name: 'campaign_updatePart_post', params });
  } catch (error) {
    throw new Error(`Pause outcome uncertain; do not retry write before reading current status: ${error?.message || error}`);
  }
  // The host waits before issuing a separate read-only verification. Background
  // tabs may suspend page timers indefinitely, including this post-write wait.
  return { ...result, message: 'pause requested; verification pending' };
}

cli({
  site: 'alimama', name: 'pause-campaign',
  description: 'Pause one campaign after identity, name, status, and latest metric checks',
  access: 'write',
  example: 'opencli alimama pause-campaign --promotion-type all-site --campaign-id CAMPAIGN_ID --expected-shop SHOP --expected-name NAME --max-roi 1.5 --min-charge 30 --execute -f json',
  domain: 'one.alimama.com', strategy: Strategy.PAGE_FETCH, browser: true, navigateBefore: false,
  args: [
    { name: 'promotion-type', type: 'str', required: true, choices: ['all-site', 'keyword'], help: 'Promotion type' },
    { name: 'campaign-id', type: 'str', required: true, help: 'Campaign ID' },
    { name: 'expected-shop', type: 'str', help: 'Exact Alimama shop identity; required with execute' },
    { name: 'expected-name', type: 'str', help: 'Exact campaign name; required with execute' },
    { name: 'report-context', type: 'str', help: 'Exact non-secret report date and attribution context from the scan' },
    { name: 'max-roi', type: 'str', help: 'Execute only when latest ROI is strictly below this number' },
    { name: 'min-charge', type: 'str', help: 'Execute only when latest charge is strictly above this number' },
    { name: 'page-size', type: 'int', default: 500, help: 'Page size from 1 to 500' },
    { name: 'max-pages', type: 'int', default: 50, help: 'Maximum pages from 1 to 200' },
    { name: 'timeout', type: 'int', default: 180, help: 'Maximum seconds for the browser command' },
    { name: 'execute', type: 'boolean', default: false, help: 'Actually pause; without this flag only preview' },
  ],
  columns: ['ok', 'shopName', 'promotionType', 'campaignId', 'campaignName', 'beforeStatus', 'afterStatus',
    'writeAttempted', 'verified', 'message'],
  func: async (page, args) => {
    const type = args['promotion-type'];
    const id = String(args['campaign-id'] ?? '');
    const execute = args.execute === true;
    if (!['all-site', 'keyword'].includes(type)) throw new Error('Invalid promotion-type');
    if (!id.trim()) throw new Error('campaign-id is required');
    const expectedShop = args['expected-shop'];
    const expectedName = args['expected-name'];
    let reportContext;
    if (args['report-context'] !== undefined) {
      try { reportContext = JSON.parse(args['report-context']); } catch { throw new Error('[PAUSE_PRECHECK:REPORT_CONTEXT_MISMATCH] Invalid report context JSON'); }
      const allowed = new Set(['sourceList', 'adzonePkgIdList', 'effectEqual', 'unifyType', 'startTime', 'endTime', 'isRt']);
      if (!reportContext || typeof reportContext !== 'object' || Array.isArray(reportContext)
          || Object.keys(reportContext).some(key => !allowed.has(key))) {
        throw new Error('[PAUSE_PRECHECK:REPORT_CONTEXT_MISMATCH] Invalid report context fields');
      }
    }
    const numberOption = name => {
      const value = args[name];
      if (value === undefined) return undefined;
      if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' ||
          !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error(`${name} must be a nonnegative finite number`);
      return Number(value);
    };
    const maxRoi = numberOption('max-roi');
    const minCharge = numberOption('min-charge');
    if (execute && (typeof expectedShop !== 'string' || !expectedShop.trim() ||
        typeof expectedName !== 'string' || !expectedName.trim() || maxRoi === undefined || minCharge === undefined)) {
      throw new Error('Execution requires expected-shop, expected-name, max-roi, and min-charge');
    }
    const pageSize = Number(args['page-size'] ?? 500);
    const maxPages = Number(args['max-pages'] ?? 50);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('page-size must be 1..500');
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) throw new Error('max-pages must be 1..200');
    const route = type === 'keyword' ? '/manage/search' : '/manage/onesite';
    const url = `https://one.alimama.com/index.html#!${route}`;
    if (typeof page.newTab !== 'function' || typeof page.setActivePage !== 'function'
        || typeof page.closeTab !== 'function' || typeof page.tabs !== 'function') {
      throw new Error('OpenCLI dedicated page lifecycle API is unavailable');
    }
    // Trace capture can create a blank session page before this adapter starts.
    // newTab would orphan that page: Bridge 1.0.23 tracks only one preferred tab.
    // Consume only an unambiguous blank in this adapter session. A nonblank page
    // may contain an older operation, so retain the fresh-page path for it.
    const sessionTabs = await page.tabs();
    if (!Array.isArray(sessionTabs)) throw new Error('OpenCLI did not return the session pages');
    const blank = sessionTabs.length === 1 && sessionTabs[0]?.url === 'about:blank'
      && typeof sessionTabs[0].page === 'string' && sessionTabs[0].page.trim()
      && sessionTabs[0].page === sessionTabs[0].page.trim()
      && typeof page.goto === 'function' ? sessionTabs[0] : null;
    let target;
    const cleanup = { pageClosed: false, reusedBlank: Boolean(blank) };
    try {
      if (blank) {
        target = blank.page;
        page.setActivePage(target);
        await page.goto(url, { waitUntil: 'none' });
      } else {
        target = await page.newTab(url);
        if (typeof target !== 'string' || !target) throw new Error('OpenCLI did not identify the new pause page');
        page.setActivePage(target);
      }
      try { await page.startNetworkCapture?.(); } catch { /* optional trace */ }
      try { if (typeof page.handleJavaScriptDialog === 'function') await page.handleJavaScriptDialog(false); } catch { /* no dialog */ }
      try { if (typeof page.pressKey === 'function') await page.pressKey('Escape'); } catch { /* best effort */ }
      const options = { type, id, execute, expectedShop, expectedName, maxRoi, minCharge, reportContext };
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
      // These timers must run in Node, never inside the background tab.
      await wait(4000);
      const evaluate = async opts => {
        for (let attempt = 0; ; attempt++) {
          try { return await page.evaluate(`(${pauseCampaignPage.toString()})(${JSON.stringify(opts)})`); }
          catch (error) {
            // Only retry a definitive pre-read readiness failure. Never replay a
            // request after a query/write timeout or a verification failure.
            if (attempt >= 19 || !/^(?:Error: )?Campaign list is not ready(?:\n|$)/.test(error?.message || '')) throw error;
            await wait(500);
          }
        }
      };
      const result = await evaluate(options);
      if (!execute) return { ...result, cleanup };
      await wait(1200);
      try {
        const after = await evaluate({ ...options, execute: false, verify: true });
        return { ...after, beforeStatus: result.beforeStatus, cleanup };
      } catch (error) {
        throw new Error(`Pause was requested but verification failed; do not retry write before reading current status: ${error?.message || error}`);
      }
    } finally {
      // A cleanup error must not erase a verified result or a definitive
      // pre-write rejection. Never log its potentially sensitive raw message.
      try {
        if (typeof target !== 'string' || !target) throw new Error('No owned page to release');
        // Older Bridge versions can silently resolve a stale target ID to the
        // current preferred tab. Refuse cleanup if ownership has changed.
        const current = await page.tabs();
        if (!Array.isArray(current) || current.length !== 1 || current[0]?.page !== target) {
          throw new Error('Pause page is no longer the current session page');
        }
        await page.closeTab(target);
        const remaining = await page.tabs();
        if (!Array.isArray(remaining) || remaining.some(tab => tab?.page === target)) {
          throw new Error('Pause page lease was not released');
        }
        // Bridge may retain a reusable about:blank container tab. This flag
        // confirms release of the operation page, not physical window closure.
        cleanup.pageClosed = true;
        console.error('[PAUSE_PAGE:CLOSED]');
      } catch {
        console.error('[PAUSE_PAGE:CLOSE_FAILED]');
      }
    }
  },
});

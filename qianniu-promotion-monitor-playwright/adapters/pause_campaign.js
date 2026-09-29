/*
 * Guarded single-plan pause in an authenticated Alimama page.
 * Playwright replaces the __INPUT__ token with JSON before evaluation.
 * Input: {type,id,execute,verify?,expectedShop,expectedAccount?,expectedName,maxRoi,minCharge,reportContext}
 * This expression performs at most one write and never retries it. The host
 * must persist intent before evaluation, then run a separate target read-back.
 */
(async function pauseCampaignPage(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Pause options are required');
  if (!['all-site', 'keyword'].includes(options.type)) throw new Error('Invalid promotion type');
  if (typeof options.id !== 'string' || !options.id.trim() || options.id !== options.id.trim()) {
    throw new Error('campaign id is required');
  }
  if (options.execute !== undefined && typeof options.execute !== 'boolean') throw new Error('execute must be boolean');
  if (options.verify !== undefined && typeof options.verify !== 'boolean') throw new Error('verify must be boolean');
  if (options.execute === true && options.verify === true) throw new Error('Choose execute or verify');
  if (options.execute === true && options.reportContext === undefined) {
    throw new Error('[PAUSE_PRECHECK:REPORT_CONTEXT_MISMATCH] Execution requires the scan report context');
  }
  if (options.expectedAccount !== undefined
      && (typeof options.expectedAccount !== 'string' || !options.expectedAccount.trim())) {
    throw new Error('expectedAccount must be a non-empty account');
  }
  if (options.reportContext !== undefined) {
    const context = options.reportContext;
    const allowed = new Set(['sourceList', 'adzonePkgIdList', 'effectEqual', 'unifyType', 'startTime', 'endTime', 'isRt']);
    if (!context || typeof context !== 'object' || Array.isArray(context)
        || Object.keys(context).some(key => !allowed.has(key))) {
      throw new Error('[PAUSE_PRECHECK:REPORT_CONTEXT_MISMATCH] Invalid report context fields');
    }
  }

  const { type, id, execute, verify, expectedShop, expectedAccount, expectedName, maxRoi, minCharge, reportContext } = options;
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
  const validDate = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
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
        || !validDate(item.startTime) || !validDate(item.endTime)
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
    if (expectedAccount !== undefined && nickName !== expectedAccount) throw new Error('Account identity does not match expected-account');
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
    identity();
    const response = await api({ ...JSON.parse(JSON.stringify(base)), campaignId: id, offset: 0, pageSize: 2 });
    identity();
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
    nickName: String(view.updater.get('user')?.meta?.nickName || ''),
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
  const metric = (value, field) => {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return 0;
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new Error(`[PAUSE_PRECHECK:INVALID_METRICS] Invalid metric: ${field}`);
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`[PAUSE_PRECHECK:INVALID_METRICS] Invalid metric: ${field}`);
    return number;
  };
  const report = campaign.reportInfoList?.[0] || {};
  const roi = metric(type === 'keyword' ? report.roi : report.retainedRoi, 'roi');
  const charge = metric(report.charge, 'charge');
  if (!(roi < maxRoi && charge > minCharge)) {
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
)(__INPUT__)

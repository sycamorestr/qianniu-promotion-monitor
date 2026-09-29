/*
 * Read active Alimama campaigns from the page's authenticated Magix view.
 *
 * This file is evaluated by Playwright with `page.evaluate`.  The controller
 * replaces the __INPUT__ token with a JSON value before evaluation, so the
 * expression below must remain self contained and may not import modules or
 * reference Node globals.
 *
 * Input:
 *   { type: "all-site"|"keyword", reportDate, isRt, expectedShop,
 *     expectedAccount?, pageSize, maxPages, targets? }
 *
 * A full scan returns {shopName, nickName, reportContext, rows}; a target
 * scan returns the same shape with one verification row per requested ID.
 */
(async () => {
  const input = __INPUT__;
  const type = input?.type;
  if (type !== 'all-site' && type !== 'keyword') throw new Error('Invalid promotion type');
  const pageSize = Number(input?.pageSize ?? 500);
  const maxPages = Number(input?.maxPages ?? 50);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new Error('pageSize must be 1..500');
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) {
    throw new Error('maxPages must be 1..200');
  }
  const reportDate = input?.reportDate;
  const reportTime = typeof reportDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reportDate)
    ? new Date(`${reportDate}T00:00:00.000Z`) : null;
  if (!reportTime || !Number.isFinite(reportTime.getTime()) || reportTime.toISOString().slice(0, 10) !== reportDate) {
    throw new Error('reportDate must be a valid YYYY-MM-DD date');
  }
  if (typeof input.isRt !== 'boolean') throw new Error('isRt must be boolean');
  if (typeof input.expectedShop !== 'string' || !input.expectedShop.trim()) {
    throw new Error('expectedShop is required');
  }
  if (input.expectedAccount !== undefined
      && (typeof input.expectedAccount !== 'string' || !input.expectedAccount.trim())) {
    throw new Error('expectedAccount must be a non-empty account');
  }

  const route = type === 'keyword' ? '/manage/search' : '/manage/onesite';
  const routeMatches = href => {
    try {
      const pageUrl = new URL(href);
      if (pageUrl.protocol !== 'https:' || pageUrl.hostname !== 'one.alimama.com'
          || !pageUrl.hash.startsWith('#!')) return false;
      const virtualUrl = new URL(pageUrl.hash.slice(2), pageUrl.origin);
      return virtualUrl.pathname.replace(/\/$/, '') === route;
    } catch { return false; }
  };
  const assertRoute = () => {
    const href = String(location.href || '');
    if (/(?:\/login|\/signin|passport)/i.test(href)) {
      throw new Error('Authentication required: Alimama login page is active');
    }
    if (!routeMatches(href)) throw new Error('Not on requested Alimama page');
  };

  // Close only recognized marketing dialogs.  In particular, never select a
  // broad text match that might click an "立即投放" primary action.
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
    } catch { /* best effort; read guards below remain authoritative */ }
  };

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
        || typeof item.isRt !== 'boolean');

  assertRoute();
  dismissKnownMarketingOverlay();
  const pattern = type === 'keyword' ? /search\/campaign-list/ : /onesite\/campaign-list/;
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
  let view;
  let api;
  let submit;
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
  if (!view) throw new Error(`${type} campaign list is not ready`);

  const identity = () => {
    assertRoute();
    const nickName = String(view.updater.get('user')?.meta?.nickName || '');
    const shopName = nickName.split(/[:：]/)[0].trim();
    if (!shopName) throw new Error('Logged-in shop identity is unavailable');
    if (shopName !== input.expectedShop) throw new Error('Shop identity does not match expectedShop');
    if (input.expectedAccount !== undefined && nickName !== input.expectedAccount) {
      throw new Error('Account identity does not match expectedAccount');
    }
    return { shopName, nickName };
  };
  const before = identity();
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
    statusList: ['start'],
    rptQuery: JSON.parse(JSON.stringify(submit.rptQuery)),
  };
  // Dates belong to this run, never to a persistent page's previous selection.
  // Preserve the page's known source and attribution settings verbatim.
  Object.assign(base.rptQuery.conditionList[0], {
    startTime: reportDate, endTime: reportDate, isRt: input.isRt,
  });
  const fields = String(base.rptQuery.fields || '').split(',').filter(Boolean);
  for (const field of type === 'keyword' ? ['roi', 'charge'] : ['retainedRoi', 'charge']) {
    if (!fields.includes(field)) fields.push(field);
  }
  base.rptQuery.fields = fields.join(',');
  const condition = base.rptQuery.conditionList[0];
  const reportContext = Object.fromEntries(['sourceList', 'adzonePkgIdList', 'effectEqual', 'unifyType',
    'startTime', 'endTime', 'isRt'].filter(key => condition[key] !== undefined).map(key => [key, condition[key]]));
  const query = async params => {
    identity();
    try {
      const result = await api(params);
      identity();
      return result;
    }
    catch (error) { throw new Error(`Campaign query failed: ${error?.message || error}`); }
  };
  const metric = (value, field) => {
    // The shop's rule treats blank report cells as zero, including an absent
    // field. Malformed nonblank data must not become a zero-ROI candidate.
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return 0;
    if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`Invalid metric: ${field}`);
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Invalid metric: ${field}`);
    return number;
  };

  const targets = input?.targets;
  if (targets !== undefined) {
    const promotionType = type === 'keyword' ? '关键词推广' : '全站推';
    if (!Array.isArray(targets) || !targets.length || targets.some(target => !target
        || typeof target.campaignId !== 'string' || !target.campaignId.trim()
        || target.campaignId !== target.campaignId.trim()
        || typeof target.campaignName !== 'string' || !target.campaignName.trim()
        || (target.promotionType !== undefined && target.promotionType !== promotionType))) {
      throw new Error('targets require exact campaignId and campaignName for the requested promotion type');
    }
    if (new Set(targets.map(target => target.campaignId)).size !== targets.length) {
      throw new Error('targets contain duplicate campaign IDs');
    }
    const rows = [];
    for (const target of targets) {
      const campaignId = String(target.campaignId);
      const response = await query({ ...JSON.parse(JSON.stringify(base)), statusList: ['start', 'pause'],
        campaignId, offset: 0, pageSize: 2 });
      const data = response?.data;
      if (!Array.isArray(data?.list)) throw new Error('Target query did not return data.list');
      if (data.list.length > 1 || data.list.some(row => !row || String(row.campaignId) !== campaignId)) {
        throw new Error('Target query returned unrelated or duplicate campaign IDs');
      }
      if (data.count !== undefined && data.count !== null) {
        const count = Number(data.count);
        if (!['string', 'number'].includes(typeof data.count) || String(data.count).trim() === ''
            || !Number.isSafeInteger(count) || count !== data.list.length) {
          throw new Error('Target query count does not match exact result');
        }
      }
      const current = identity();
      if (current.shopName !== before.shopName) throw new Error('Shop identity changed during target verification');
      const row = data.list[0];
      const nameMatches = row?.campaignName === target.campaignName;
      const outcome = nameMatches && row.displayStatus === 'start' && row.onlineStatus === 1 ? 'active'
        : nameMatches && row.displayStatus === 'pause' && row.onlineStatus === 0 ? 'inactive' : 'unverified';
      const report = row?.reportInfoList?.[0] || {};
      rows.push({ recordType: 'verification', shopName: before.shopName,
        promotionType: type === 'keyword' ? '关键词推广' : '全站推', campaignId,
        campaignName: row?.campaignName || target.campaignName, outcome,
        verified: outcome !== 'unverified', reportContext,
        roi: metric(type === 'keyword' ? report.roi : report.retainedRoi, 'roi'),
        charge: metric(report.charge, 'charge'), displayStatus: row?.displayStatus ?? null,
        onlineStatus: row?.onlineStatus ?? null });
    }
    return { ...before, reportContext, rows };
  }

  const rows = [];
  const ids = new Set();
  let total = null;
  let complete = false;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const response = await query({ ...JSON.parse(JSON.stringify(base)), offset: rows.length, pageSize });
    const data = response?.data;
    if (!Array.isArray(data?.list)) {
      throw new Error(`Campaign query failed: ${response?.info?.message || 'API did not return data.list'}`);
    }
    if (data.list.length > pageSize) throw new Error('API returned more rows than requested');
    if (data.count !== undefined && data.count !== null) {
      const count = Number(data.count);
      if ((typeof data.count !== 'number' && typeof data.count !== 'string')
          || String(data.count).trim() === '' || !Number.isSafeInteger(count) || count < 0) {
        throw new Error('API returned invalid data.count');
      }
      if (total !== null && count !== total) throw new Error('Campaign count changed during pagination');
      total = count;
    }
    for (const row of data.list) {
      if (!row || row.campaignId === undefined || row.campaignId === null || String(row.campaignId) === '') {
        throw new Error('API returned a campaign without an ID');
      }
      const id = String(row.campaignId);
      if (ids.has(id)) throw new Error('API returned duplicate campaign IDs during pagination');
      ids.add(id);
      rows.push(row);
    }
    if (total !== null && rows.length > total) throw new Error('API list exceeds data.count');
    if (data.list.length < pageSize || (total !== null && rows.length >= total)) {
      if (total !== null && rows.length !== total) throw new Error('Pagination incomplete');
      complete = true;
      break;
    }
  }
  if (!complete) throw new Error('Pagination incomplete: increase maxPages');
  const after = identity();
  if (after.shopName !== before.shopName) throw new Error('Shop identity changed during scan');
  return {
    ...after,
    reportContext,
    rows: rows.filter(row => row.displayStatus === 'start' && row.onlineStatus === 1).map(row => {
      const report = row.reportInfoList?.[0] || {};
      return {
        recordType: 'campaign', shopName: after.shopName,
        promotionType: type === 'keyword' ? '关键词推广' : '全站推',
        campaignName: row.campaignName || '', campaignId: String(row.campaignId), reportContext,
        // Preserve raw precision for threshold decisions; format only in messages.
        roi: metric(type === 'keyword' ? report.roi : report.retainedRoi, 'roi'),
        charge: metric(report.charge, 'charge'), onlineStatus: row.onlineStatus, displayStatus: row.displayStatus,
      };
    }),
  };
})()

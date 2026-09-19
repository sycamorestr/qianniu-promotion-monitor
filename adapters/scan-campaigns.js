import { cli, Strategy } from '@jackwener/opencli/registry';

const URLS = {
  'all-site': 'https://one.alimama.com/index.html#!/manage/onesite',
  keyword: 'https://one.alimama.com/index.html#!/manage/search',
};

// This function is serialized into the existing browser page. Keep it self-contained.
export async function scanCampaignPage({ type, pageSize, maxPages, targets }) {
  await new Promise(resolve => setTimeout(resolve, 4000));
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
    } catch { /* Marketing-overlay dismissal is best effort; read guards remain authoritative. */ }
  };
  let view, api, submit;
  for (let attempt = 0; attempt < 20; attempt++) {
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
    if (view) break;
    if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!view) throw new Error(`${type} campaign list is not ready`);

  const identity = () => {
    const nickName = String(view.updater.get('user')?.meta?.nickName || '');
    const shopName = nickName.split(/[:：]/)[0].trim();
    if (!shopName) throw new Error('Logged-in shop identity is unavailable');
    return { shopName, nickName };
  };
  const before = identity();
  // Preserve report date/attribution context, but allowlist only structural list fields so stale UI filters cannot hide a plan.
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
  const fields = String(base.rptQuery.fields || '').split(',').filter(Boolean);
  for (const field of type === 'keyword' ? ['roi', 'charge'] : ['retainedRoi', 'charge']) {
    if (!fields.includes(field)) fields.push(field);
  }
  base.rptQuery.fields = fields.join(',');

  const metric = value => {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  if (targets) {
    const rows = [];
    for (const target of targets) {
      // Native onebp mxSearch uses searchKey=campaignId; mxSetParams converts it to campaignId.
      // Include both native status values so an explicitly paused row remains visible.
      const response = await api({ ...JSON.parse(JSON.stringify(base)), statusList: ['start', 'pause'],
        campaignId: target.campaignId, offset: 0, pageSize: 2 });
      const data = response?.data;
      if (!Array.isArray(data?.list)) throw new Error('Target query did not return data.list');
      if (data.list.length > 1 || data.list.some(row => !row || String(row.campaignId) !== target.campaignId)) {
        throw new Error('Target query returned unrelated or duplicate campaign IDs');
      }
      if (data.count !== undefined && data.count !== null) {
        const count = Number(data.count);
        if (!['string', 'number'].includes(typeof data.count) || String(data.count).trim() === ''
            || !Number.isSafeInteger(count) || count !== data.list.length) throw new Error('Target query count does not match exact result');
      }
      if (identity().shopName !== before.shopName) throw new Error('Shop identity changed during target verification');
      const row = data.list[0];
      const nameMatches = row?.campaignName === target.campaignName;
      const outcome = nameMatches && row.displayStatus === 'start' && row.onlineStatus === 1 ? 'active'
        : nameMatches && row.displayStatus === 'pause' && row.onlineStatus === 0 ? 'inactive' : 'unverified';
      const report = row?.reportInfoList?.[0] || {};
      rows.push({ recordType: 'verification', shopName: before.shopName,
        promotionType: type === 'keyword' ? '关键词推广' : '全站推', campaignId: target.campaignId,
        campaignName: row?.campaignName || target.campaignName, outcome, verified: outcome !== 'unverified',
        roi: metric(type === 'keyword' ? report.roi : report.retainedRoi), charge: metric(report.charge),
        displayStatus: row?.displayStatus ?? null, onlineStatus: row?.onlineStatus ?? null });
    }
    return { ...identity(), rows };
  }

  const rows = [];
  const ids = new Set();
  let total = null;
  let complete = false;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const params = { ...JSON.parse(JSON.stringify(base)), offset: rows.length, pageSize };
    const response = await api(params);
    const data = response?.data;
    if (!Array.isArray(data?.list)) {
      throw new Error(response?.info?.message || 'API did not return data.list');
    }
    if (data.list.length > pageSize) throw new Error('API returned more rows than requested');
    if (data.count !== undefined && data.count !== null) {
      const count = Number(data.count);
      if ((typeof data.count !== 'number' && typeof data.count !== 'string') ||
          String(data.count).trim() === '' || !Number.isSafeInteger(count) || count < 0) {
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
  if (!complete) throw new Error('Pagination incomplete: increase max-pages');
  const after = identity();
  if (after.shopName !== before.shopName) throw new Error('Shop identity changed during scan');
  return {
    ...after,
    rows: rows.filter(row => row.displayStatus === 'start' && row.onlineStatus === 1).map(row => {
      const report = row.reportInfoList?.[0] || {};
      return {
        recordType: 'campaign',
        shopName: after.shopName,
        promotionType: type === 'keyword' ? '关键词推广' : '全站推',
        campaignName: row.campaignName || '',
        campaignId: String(row.campaignId),
        // Preserve raw precision for threshold decisions; round only when displaying.
        roi: metric(type === 'keyword' ? report.roi : report.retainedRoi),
        charge: metric(report.charge),
        onlineStatus: row.onlineStatus,
        displayStatus: row.displayStatus,
      };
    }),
  };
}

cli({
  site: 'alimama', name: 'scan-campaigns',
  description: 'Scan identity and active all-site/keyword campaigns in one browser page',
  access: 'read', example: 'opencli alimama scan-campaigns -f json',
  domain: 'one.alimama.com', strategy: Strategy.PAGE_FETCH, browser: true, navigateBefore: false,
  args: [
    { name: 'page-size', type: 'int', default: 500, help: 'Page size from 1 to 500' },
    { name: 'max-pages', type: 'int', default: 50, help: 'Maximum pages from 1 to 200' },
    { name: 'timeout', type: 'int', default: 180, help: 'Maximum seconds for the browser command' },
    { name: 'targets', type: 'str', help: 'JSON array of exact promotionType, campaignId and campaignName targets; checks only these plans' },
  ],
  columns: ['recordType', 'shopName', 'promotionType', 'campaignName', 'campaignId', 'roi', 'charge', 'onlineStatus', 'displayStatus', 'outcome', 'verified'],
  func: async (page, args) => {
    const pageSize = Number(args['page-size'] ?? 500);
    const maxPages = Number(args['max-pages'] ?? 50);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('page-size must be 1..500');
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) throw new Error('max-pages must be 1..200');
    let targets;
    if (args.targets !== undefined) {
      try { targets = JSON.parse(args.targets); } catch { throw new Error('targets must be a JSON array'); }
      if (!Array.isArray(targets) || !targets.length || targets.some(target => !target
          || !['全站推', '关键词推广'].includes(target.promotionType)
          || typeof target.campaignId !== 'string' || !target.campaignId.trim()
          || target.campaignId !== target.campaignId.trim()
          || typeof target.campaignName !== 'string' || !target.campaignName.trim())) {
        throw new Error('targets require exact promotionType, campaignId and campaignName');
      }
      if (new Set(targets.map(target => `${target.promotionType}|${target.campaignId}`)).size !== targets.length) {
        throw new Error('targets contain duplicate campaign identities');
      }
    }
    const navigate = async url => {
      if (typeof page.goto === 'function') await page.goto(url, { waitUntil: 'none' });
      else if (typeof page.navigate === 'function') await page.navigate(url);
      else throw new Error('OpenCLI page navigation API is unavailable');
    };
    const read = (type, selected) => page.evaluate(`(${scanCampaignPage.toString()})(${JSON.stringify({ type, pageSize, maxPages, targets: selected })})`);
    if (targets) {
      let identity;
      const rows = [];
      for (const [type, promotionType] of [['all-site', '全站推'], ['keyword', '关键词推广']]) {
        const selected = targets.filter(target => target.promotionType === promotionType);
        if (!selected.length) continue;
        await navigate(URLS[type]);
        const result = await read(type, selected);
        if (identity && identity.shopName !== result.shopName) throw new Error('Shop identity changed during target verification');
        identity ||= { recordType: 'identity', shopName: result.shopName, nickName: result.nickName };
        rows.push(...result.rows);
      }
      return [identity, ...rows];
    }
    await navigate(URLS['all-site']);
    const allSite = await read('all-site');
    await navigate(URLS.keyword);
    const keyword = await read('keyword');
    if (keyword.shopName !== allSite.shopName) {
      throw new Error(`Shop identity changed during scan: ${allSite.shopName} -> ${keyword.shopName}`);
    }
    return [{ recordType: 'identity', shopName: allSite.shopName, nickName: allSite.nickName }, ...allSite.rows, ...keyword.rows];
  },
});

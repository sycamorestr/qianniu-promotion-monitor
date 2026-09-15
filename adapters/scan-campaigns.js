import { cli, Strategy } from '@jackwener/opencli/registry';

const URLS = {
  'all-site': 'https://one.alimama.com/index.html#!/manage/onesite',
  keyword: 'https://one.alimama.com/index.html#!/manage/search',
};

// This function is serialized into the existing browser page. Keep it self-contained.
export async function scanCampaignPage({ type, pageSize, maxPages }) {
  await new Promise(resolve => setTimeout(resolve, 4000));
  const route = type === 'keyword' ? '/manage/search' : '/manage/onesite';
  if (location.hostname !== 'one.alimama.com' || !location.href.includes(route)) {
    throw new Error('Not on requested Alimama page');
  }
  if (!window.seajs?.cache) throw new Error('seajs missing');
  let Magix;
  for (const entry of Object.values(window.seajs.cache)) {
    const exported = entry?.exports;
    const candidate = exported?.default?.Vframe ? exported.default : exported;
    if (candidate?.Vframe && candidate?.Router && candidate?.State) {
      Magix = candidate;
      break;
    }
  }
  if (!Magix) throw new Error('Magix missing');
  const pattern = type === 'keyword' ? /search\/campaign-list/ : /onesite\/campaign-list/;
  const frame = Object.values(Magix.Vframe.all()).find(item => pattern.test(item.path || ''));
  const view = frame?.$v;
  const api = view?.requester?.campaign_horizontal_findPage_post;
  const submit = view?.updater?.get('submitParams');
  const conditionList = submit?.rptQuery?.conditionList;
  const reportValue = value => (typeof value === 'string' || typeof value === 'number')
    && String(value).trim() !== '';
  const attributionReady = item => (reportValue(item?.effectEqual) && reportValue(item?.unifyType))
    || (type === 'keyword'
      && Object.prototype.hasOwnProperty.call(item || {}, 'effectEqual')
      && Object.prototype.hasOwnProperty.call(item || {}, 'unifyType')
      && item.effectEqual === undefined && item.unifyType === undefined);
  if (typeof api !== 'function' || !Array.isArray(conditionList) || !conditionList.length
      || conditionList.length !== 1
      || conditionList.some(item => !item || typeof item !== 'object' || Array.isArray(item) || !Object.keys(item).length
        || !Array.isArray(item.sourceList) || !item.sourceList.length
        || item.sourceList.some(value => typeof value !== 'string' || !value.trim())
        || !Array.isArray(item.adzonePkgIdList)
        || !attributionReady(item)
        || typeof item.startTime !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.startTime)
        || typeof item.endTime !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.endTime)
        || typeof item.isRt !== 'boolean'
      )) {
    throw new Error(`${type} campaign list is not ready`);
  }

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
  const metric = value => {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
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
  domain: 'one.alimama.com', strategy: Strategy.PAGE_FETCH, browser: true,
  args: [
    { name: 'page-size', type: 'int', default: 500, help: 'Page size from 1 to 500' },
    { name: 'max-pages', type: 'int', default: 50, help: 'Maximum pages from 1 to 200' },
  ],
  columns: ['recordType', 'shopName', 'promotionType', 'campaignName', 'campaignId', 'roi', 'charge', 'onlineStatus', 'displayStatus'],
  func: async (page, args) => {
    const pageSize = Number(args['page-size'] ?? 500);
    const maxPages = Number(args['max-pages'] ?? 50);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('page-size must be 1..500');
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) throw new Error('max-pages must be 1..200');
    const navigate = async url => {
      if (typeof page.goto === 'function') await page.goto(url);
      else if (typeof page.navigate === 'function') await page.navigate(url);
      else throw new Error('OpenCLI page navigation API is unavailable');
    };
    const read = type => page.evaluate(`(${scanCampaignPage.toString()})(${JSON.stringify({ type, pageSize, maxPages })})`);
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

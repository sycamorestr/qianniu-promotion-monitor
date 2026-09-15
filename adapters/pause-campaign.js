import { cli, Strategy } from '@jackwener/opencli/registry';

// Executed in the authenticated page; no external module closures are available here.
export async function pauseCampaignPage(options) {
  const { type, id, execute, expectedShop, expectedName, maxRoi, minCharge, pageSize, maxPages } = options;
  await new Promise(resolve => setTimeout(resolve, 4000));
  const route = type === 'keyword' ? '/manage/search' : '/manage/onesite';
  const assertRoute = () => {
    if (location.hostname !== 'one.alimama.com' || !location.href.includes(route)) {
      throw new Error('Not on requested Alimama page');
    }
  };
  assertRoute();
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
    throw new Error('Campaign list is not ready');
  }
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
    statusList: ['start'],
    rptQuery: JSON.parse(JSON.stringify(submit.rptQuery)),
  };
  const fields = String(base.rptQuery.fields || '').split(',').filter(Boolean);
  for (const field of type === 'keyword' ? ['roi', 'charge'] : ['retainedRoi', 'charge']) {
    if (!fields.includes(field)) fields.push(field);
  }
  base.rptQuery.fields = fields.join(',');

  // A missing ID proves inactivity only after the entire active list was read.
  const readActiveCampaigns = async () => {
    const rows = [];
    const ids = new Set();
    let total = null;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      const params = { ...JSON.parse(JSON.stringify(base)), offset: rows.length, pageSize };
      const response = await api(params);
      const data = response?.data;
      if (!Array.isArray(data?.list)) throw new Error(response?.info?.message || 'API did not return data.list');
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
        const campaignId = String(row.campaignId);
        if (ids.has(campaignId)) throw new Error('API returned duplicate campaign IDs during pagination');
        ids.add(campaignId);
        rows.push(row);
      }
      if (total !== null && rows.length > total) throw new Error('API list exceeds data.count');
      if (data.list.length < pageSize || (total !== null && rows.length >= total)) {
        if (total !== null && rows.length !== total) throw new Error('Pagination incomplete');
        return rows;
      }
    }
    throw new Error('Pagination incomplete: increase max-pages');
  };
  const campaigns = await readActiveCampaigns();
  const campaign = campaigns.find(row => String(row.campaignId) === id);
  if (!campaign) throw new Error('campaign-id not found in active campaign list');
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
  if (!execute) return result;
  // Recheck every guard inside the page immediately before the only write call.
  if (!expectedShop || !expectedName || !Number.isFinite(maxRoi) || !Number.isFinite(minCharge)) {
    throw new Error('Execution requires expected-shop, expected-name, max-roi, and min-charge');
  }
  if (campaign.displayStatus !== 'start' || campaign.onlineStatus !== 1) {
    throw new Error('Campaign must have displayStatus=start AND onlineStatus=1');
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
    throw new Error('Latest campaign metrics no longer satisfy ROI < max-roi and charge > min-charge');
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
  try {
    await new Promise(resolve => setTimeout(resolve, 1200));
    identity();
    const afterRows = await readActiveCampaigns();
    identity();
    const after = afterRows.find(row => String(row.campaignId) === id);
    if (after) {
      if (after.campaignName !== expectedName) throw new Error('Campaign name changed during verification');
      if (typeof after.displayStatus !== 'string' || !after.displayStatus ||
          typeof after.onlineStatus !== 'number' || !Number.isFinite(after.onlineStatus)) {
        throw new Error('API returned invalid campaign status during verification');
      }
      if (after.displayStatus === 'start' || after.onlineStatus === 1) {
        throw new Error('Campaign is still active');
      }
      if (after.displayStatus !== 'pause' || after.onlineStatus !== 0) {
        throw new Error('API returned an unrecognized inactive campaign status');
      }
    }
    result.afterStatus = after ? after.displayStatus : 'not-in-active-list';
    result.verified = true;
    result.message = 'paused and verified';
    return result;
  } catch (error) {
    throw new Error(`Pause was requested but verification failed; do not retry write before reading current status: ${error?.message || error}`);
  }
}

cli({
  site: 'alimama', name: 'pause-campaign',
  description: 'Pause one campaign after identity, name, status, and latest metric checks',
  access: 'write',
  example: 'opencli alimama pause-campaign --promotion-type all-site --campaign-id CAMPAIGN_ID --expected-shop SHOP --expected-name NAME --max-roi 1.5 --min-charge 30 --execute -f json',
  domain: 'one.alimama.com', strategy: Strategy.PAGE_FETCH, browser: true,
  args: [
    { name: 'promotion-type', type: 'str', required: true, choices: ['all-site', 'keyword'], help: 'Promotion type' },
    { name: 'campaign-id', type: 'str', required: true, help: 'Campaign ID' },
    { name: 'expected-shop', type: 'str', help: 'Exact Alimama shop identity; required with execute' },
    { name: 'expected-name', type: 'str', help: 'Exact campaign name; required with execute' },
    { name: 'max-roi', type: 'str', help: 'Execute only when latest ROI is strictly below this number' },
    { name: 'min-charge', type: 'str', help: 'Execute only when latest charge is strictly above this number' },
    { name: 'page-size', type: 'int', default: 500, help: 'Page size from 1 to 500' },
    { name: 'max-pages', type: 'int', default: 50, help: 'Maximum pages from 1 to 200' },
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
    if (typeof page.goto === 'function') await page.goto(url);
    else if (typeof page.navigate === 'function') await page.navigate(url);
    else throw new Error('OpenCLI page navigation API is unavailable');
    const options = { type, id, execute, expectedShop, expectedName, maxRoi, minCharge, pageSize, maxPages };
    return page.evaluate(`(${pauseCampaignPage.toString()})(${JSON.stringify(options)})`);
  },
});

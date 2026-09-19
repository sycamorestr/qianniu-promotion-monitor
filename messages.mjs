const keyOf = row => `${row.profile}|${row.promotionType}|${row.campaignId}`;
const safeText = value => String(value ?? '-').replace(/[\r\n\t]/g, ' ').replace(/[<>&`*_\[\]]/g, '');
const metric = value => Number.isFinite(value) ? value.toFixed(2) : '-';
const color = (name, value) => `<font color="${name}">${value}</font>`;
const compactText = (value, maxCharacters = 80) => {
  const characters = [...safeText(value)];
  return characters.length <= maxCharacters ? characters.join('') : `${characters.slice(0, maxCharacters - 3).join('')}...`;
};
const campaignDetails = row => `${safeText(row.promotionType)}｜花费 ${metric(row.charge)}｜ROI ${metric(row.roi)}｜ID ${safeText(row.campaignId)}`;
const pauseLine = (row, label, statusColor, note = '') => `- ${color(statusColor, label)}｜${compactText(row.campaignName)}｜${color('comment', campaignDetails(row))}${note ? `｜${color('comment', note)}` : ''}`;
const lowRoiLine = row => `- ${compactText(row.campaignName)}｜${safeText(row.promotionType)}｜花费 ${metric(row.charge)}｜ROI ${color('warning', metric(row.roi))}｜${color('comment', `ID ${safeText(row.campaignId)}`)}`;
const uniqueRows = rows => [...new Map((rows || []).map(row => [keyOf(row), row])).values()];

export function splitMessages(header, lines, maxBytes = 4000) {
  if (Buffer.byteLength(header, 'utf8') > maxBytes - 8) throw new Error('Notification header too long');
  const parts = [];
  let current = header;
  for (const line of lines) {
    // Split even a single exceptionally long plan name without splitting UTF-8 code points.
    for (const character of `\n${line}`) {
      if (Buffer.byteLength(current + character, 'utf8') > maxBytes) {
        parts.push(current);
        current = `${header}\n`;
      }
      current += character;
    }
  }
  if (current) parts.push(current);
  return parts;
}

const appendBlock = (content, block) => `${content}\n${block}`;
const fits = (content, maxBytes) => Buffer.byteLength(content, 'utf8') <= maxBytes;

// Repeat shop and stage headings when a shop spans multiple WeCom messages.
export function splitShopMessages(header, sections, maxBytes = 4000) {
  if (Buffer.byteLength(header, 'utf8') > maxBytes - 8) throw new Error('Notification header too long');
  const parts = [];
  let current = header;
  const flush = () => {
    if (current !== header) parts.push(current);
    current = header;
  };
  const shopPrefix = (section, continuation = false, groupHeading = '') => [
    header,
    continuation ? `${section.heading} ${color('comment', '（续）')}` : section.heading,
    section.summary,
    groupHeading,
  ].filter(Boolean).join('\n');

  for (const section of sections) {
    const block = [section.heading, section.summary,
      ...section.groups.flatMap(group => [group.heading, ...group.lines])].filter(Boolean).join('\n');
    if (fits(appendBlock(current, block), maxBytes)) {
      current = appendBlock(current, block);
      continue;
    }
    if (current !== header) flush();
    if (fits(appendBlock(header, block), maxBytes)) {
      current = appendBlock(header, block);
      continue;
    }

    current = shopPrefix(section);
    if (!fits(current, maxBytes)) throw new Error('Notification shop heading is too long');
    for (const group of section.groups) {
      if (!group.lines.length) continue;
      const first = `${group.heading}\n${group.lines[0]}`;
      if (!fits(appendBlock(current, first), maxBytes)) {
        flush();
        current = shopPrefix(section, true);
      }
      if (!fits(appendBlock(current, first), maxBytes)) throw new Error('Notification line is too long for its shop context');
      current = appendBlock(current, first);
      for (const line of group.lines.slice(1)) {
        if (!fits(appendBlock(current, line), maxBytes)) {
          flush();
          current = shopPrefix(section, true, group.heading);
        }
        if (!fits(appendBlock(current, line), maxBytes)) throw new Error('Notification line is too long for its shop context');
        current = appendBlock(current, line);
      }
    }
  }
  flush();
  return parts;
}

function finalOutcomes(payload, candidates, thresholds) {
  const latestReadbacks = new Map();
  for (const readback of payload.pauseReadbacks || []) {
    for (const result of readback.campaigns || []) {
      const key = keyOf({ ...result, profile: readback.profile });
      const previous = latestReadbacks.get(key);
      const checkedAt = Date.parse(readback.checkedAt);
      // Arrays are append-only in the runner; timestamps also preserve latest semantics for restored audits.
      if (previous && Number.isFinite(previous.checkedAt) && Number.isFinite(checkedAt) && checkedAt < previous.checkedAt) continue;
      latestReadbacks.set(key, { result, ok: readback.ok === true, checkedAt });
    }
  }
  const latestCloseResults = new Map((payload.closeResults || []).map(result => [keyOf(result), result]));
  return new Map(candidates.map(row => {
    const key = keyOf(row);
    const readback = latestReadbacks.get(key);
    let paused = false, current = row, note = '';
    if (payload.mode === 'execute') {
      if (readback) {
        const { result, ok } = readback;
        const identityMatches = (!result.expectedCampaignName || result.expectedCampaignName === row.campaignName)
          && (!result.current?.campaignName || result.current.campaignName === row.campaignName);
        const verified = ok && result.verified === true && identityMatches;
        paused = verified && result.outcome === 'inactive';
        if (verified && ['inactive', 'active'].includes(result.outcome) && result.current) {
          current = { ...row, ...result.current, profile: row.profile, promotionType: row.promotionType, campaignId: row.campaignId };
        }
        if (verified && result.outcome === 'active') {
          const completeMetrics = Number.isFinite(current.charge) && Number.isFinite(current.roi);
          const eligible = completeMetrics && current.charge > thresholds.closeChargeAbove && current.roi < thresholds.closeRoiBelow;
          note = completeMetrics && !eligible ? '无需暂停（指标已改善）' : '仍在推广';
        } else if (!paused) note = '待核验';
      } else {
        const result = latestCloseResults.get(key);
        paused = result?.verified === true && ['pause', 'not-in-active-list'].includes(result.afterStatus)
          && (!result.campaignName || result.campaignName === row.campaignName)
          && (!result.shopName || result.shopName === row.shopName);
        if (!paused) note = '待核验';
      }
    }
    return [key, { paused, current, note }];
  }));
}

export function buildMessages(payload, config) {
  const candidates = uniqueRows(payload.toClose);
  const candidateKeys = new Set(candidates.map(keyOf));
  const lowRows = uniqueRows(payload.lowRoi);
  const completed = config.profiles.filter(identity => payload.shops.some(shop => shop.profile === identity.profile && shop.ok)).length;
  const failedShops = config.profiles.length - completed;
  const thresholds = { closeChargeAbove: 30, closeRoiBelow: 1.5, ...config.thresholds };
  const outcomes = finalOutcomes(payload, candidates, thresholds);
  const pausedRows = candidates.filter(row => outcomes.get(keyOf(row)).paused);
  // 待暂停 is the original work list, not the remaining failures after execution.
  const counts = (waiting, paused) => [
    waiting ? color('warning', `待暂停 ${waiting} 个`) : '',
    paused ? color('info', `已暂停 ${paused} 个`) : '',
  ].filter(Boolean).join('｜');
  const title = payload.mode === 'execute' ? '# 千牛推广执行结果'
    : payload.mode === 'dry-run' ? '# 千牛推广巡检提醒' : '# 千牛推广巡检报告';
  const header = [
    title,
    `> 巡检完成 ${color('info', `${completed}/${config.profiles.length} 店`)}｜推广 ${payload.scanned} 个｜低 ROI ${color(lowRows.length ? 'warning' : 'info', `${lowRows.length} 个`)}`,
    payload.mode === 'dry-run' ? `> ${color('comment', '本次仅巡检，未执行暂停')}` : '',
    payload.mode === 'report' ? `> ${color('comment', '本次仅生成本地报告，未执行暂停')}` : '',
    candidates.length ? '' : `> ${color('comment', failedShops ? '已完成店铺中无符合暂停条件的推广' : '本次无符合暂停条件的推广')}`,
    failedShops ? `> ${color('warning', `巡检未完成 ${failedShops} 店，请人工检查`)}` : '',
  ].filter(Boolean).join('\n');

  const sections = config.profiles.map(identity => {
    const heading = `## ${compactText(identity.browserUser, 40)}`;
    if (!payload.shops.some(shop => shop.profile === identity.profile && shop.ok)) {
      return {
        heading,
        summary: `> ${color('warning', '本店巡检未完成')}`,
        groups: [{ heading: '### 巡检结果', lines: [`- ${color('warning', '请人工检查店铺登录及页面状态')}`] }],
      };
    }
    const shopLow = lowRows.filter(row => row.profile === identity.profile);
    const otherLow = shopLow.filter(row => !candidateKeys.has(keyOf(row)));
    const hasCandidates = candidates.some(row => row.profile === identity.profile);
    const groups = otherLow.length
      ? [{ heading: hasCandidates ? '### 其他低 ROI' : '### 低 ROI 推广', lines: otherLow.map(lowRoiLine) }]
      : [{ heading: '### 巡检结果', lines: [hasCandidates
        ? `- ${color('comment', '需处理计划见最后的暂停操作汇总')}`
        : `- ${color('info', '暂无低 ROI 推广')}`] }];
    return { heading, summary: `> 低 ROI ${color(shopLow.length ? 'warning' : 'info', `${shopLow.length} 个`)}`, groups };
  });
  const messages = splitShopMessages(header, sections);
  if (!candidates.length) return messages;

  const operationHeader = [
    '# 暂停操作汇总',
    `> ${counts(candidates.length, pausedRows.length)}`,
    `> ${color('comment', payload.mode === 'execute' ? '待暂停为本轮执行清单；已暂停以最终核验为准' : '待暂停为本轮需执行清单；本次未执行暂停')}`,
  ].join('\n');
  const operationSections = config.profiles.flatMap(identity => {
    const waiting = candidates.filter(row => row.profile === identity.profile);
    if (!waiting.length) return [];
    const paused = waiting.filter(row => outcomes.get(keyOf(row)).paused);
    const groups = [{
      heading: '### 待暂停',
      lines: waiting.map(row => {
        const outcome = outcomes.get(keyOf(row));
        return pauseLine(outcome.current, '待暂停', 'warning', outcome.note);
      }),
    }];
    if (paused.length) groups.push({
      heading: '### 已暂停',
      lines: paused.map(row => pauseLine(outcomes.get(keyOf(row)).current, '已暂停', 'info')),
    });
    return [{ heading: `## ${compactText(identity.browserUser, 40)}`, summary: `> ${counts(waiting.length, paused.length)}`, groups }];
  });
  return [...messages, ...splitShopMessages(operationHeader, operationSections)];
}

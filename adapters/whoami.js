import { cli, Strategy } from '@jackwener/opencli/registry';

export async function readShopIdentity() {
  await new Promise(resolve => setTimeout(resolve, 4000));
  if (location.hostname !== 'one.alimama.com') throw new Error('Not on an Alimama page');
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
  let user;
  for (const frame of Object.values(Magix.Vframe.all())) {
    const candidate = frame?.$v?.updater?.get('user');
    if (candidate?.meta?.nickName) {
      user = candidate;
      break;
    }
  }
  const nickName = String(user?.meta?.nickName || '');
  const shopName = nickName.split(/[:：]/)[0].trim();
  return [{ loggedIn: Boolean(shopName), shopName, nickName }];
}

cli({
  site: 'alimama', name: 'whoami', description: 'Show the current logged-in Alimama shop identity',
  access: 'read', example: 'opencli alimama whoami -f json', domain: 'one.alimama.com',
  strategy: Strategy.DOM_STATE, browser: true, args: [], columns: ['loggedIn', 'shopName', 'nickName'],
  func: async page => {
    const url = 'https://one.alimama.com/index.html#!/manage/onesite';
    if (typeof page.goto === 'function') await page.goto(url);
    else if (typeof page.navigate === 'function') await page.navigate(url);
    else throw new Error('OpenCLI page navigation API is unavailable');
    return page.evaluate(`(${readShopIdentity.toString()})()`);
  },
});

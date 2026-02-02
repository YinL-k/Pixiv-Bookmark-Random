/**
 * Install DNR rule so i.pximg.net images can be requested from arbitrary pages.
 * Pixiv requires a Pixiv Referer/Origin for original image access.
 */

export async function installPximgHeaderRule() {
  try {
    const rules = [{
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.pixiv.net/' },
          { header: 'Origin', operation: 'set', value: 'https://www.pixiv.net' }
        ]
      },
      condition: {
        urlFilter: '||i.pximg.net/',
        resourceTypes: ['main_frame', 'image', 'xmlhttprequest', 'media', 'other', 'sub_frame']
      }
    }];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: rules
    });
  } catch (e) {
    console.warn('[pixiv-random] DNR rule install failed:', e);
  }
}

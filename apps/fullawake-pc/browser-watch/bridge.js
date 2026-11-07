const supportedPage = /^https:\/\/www\.bilibili\.com\/video\/BV[a-zA-Z0-9]+(?:[/?#]|$)/;

async function setBadgeState(tabId, state) {
  try {
    if (!tabId) return;
    if (state === 'OFF') {
      await chrome.action.setBadgeText({ tabId, text: 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#888888' });
    } else if (state === 'ON') {
      await chrome.action.setBadgeText({ tabId, text: 'ON' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#00B0FF' });
    } else if (state === 'CLK') {
      await chrome.action.setBadgeText({ tabId, text: 'CLK' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#FF9100' });
    } else if (state === 'ERR') {
      await chrome.action.setBadgeText({ tabId, text: 'ERR' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#FF5252' });
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch {}
}

// 标签切换与更新监听：确保进入 B 站视频页时徽标状态正确
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!supportedPage.test(tab.url ?? '')) return;
  const { enabled = true } = await chrome.storage.local.get('enabled');
  if (!enabled) {
    await setBadgeState(tabId, 'OFF');
  } else {
    await setBadgeState(tabId, 'ON');
  }
});

// 点击扩展图标：全局切换 ON / OFF
chrome.action.onClicked.addListener(async tab => {
  const { enabled = true, token } = await chrome.storage.local.get(['enabled', 'token']);
  if (!token) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  const next = !enabled;
  await chrome.storage.local.set({ enabled: next });

  // 同步所有打开的 B 站视频标签
  try {
    const tabs = await chrome.tabs.query({ url: '*://www.bilibili.com/video/*' });
    for (const t of tabs) {
      if (t.id != null) {
        await setBadgeState(t.id, next ? 'ON' : 'OFF');
        chrome.tabs.sendMessage(t.id, { kind: 'watch-enabled', enabled: next }).catch(() => {});
      }
    }
    if (!tabs.length && tab?.id != null) {
      await setBadgeState(tab.id, next ? '' : 'OFF');
    }
  } catch {}
});

// 接收来自 capture.js 的时钟心跳与帧数据
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.kind !== 'watch-clock' || sender.frameId !== 0 || !supportedPage.test(sender.url ?? '')) return;
  async function forward() {
    const { port = 8765, token = '', enabled = true } = await chrome.storage.local.get(['port', 'token', 'enabled']);
    if (!enabled) {
      await setBadgeState(sender.tab?.id, 'OFF');
      return { ok: false, stopped: true };
    }
    const response = await fetch(`http://127.0.0.1:${port}/v1/watch/clock`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-fullawake-watch': token },
      body: JSON.stringify(message.clock), signal: AbortSignal.timeout(1500), redirect: 'error',
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const badge = message.stopped ? '' : message.visualError ? 'CLK' : 'ON';
    await setBadgeState(sender.tab?.id, badge);
    return response.json();
  }
  forward().then(reply, async () => {
    reply({ ok: false });
    await setBadgeState(sender.tab?.id, 'ERR');
  });
  return true;
});

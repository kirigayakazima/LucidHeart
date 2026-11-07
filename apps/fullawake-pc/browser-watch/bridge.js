const supportedPage = /^https:\/\/www\.bilibili\.com\/video\/BV[a-zA-Z0-9]+(?:[/?#]|$)/;

chrome.action.onClicked.addListener(async tab => {
  if (!supportedPage.test(tab.url ?? '')) return;
  if (!(await chrome.storage.local.get('token')).token) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js'] });
  } catch {
    await chrome.action.setBadgeText({ tabId: tab.id, text: 'ERR' });
  }
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.kind !== 'watch-clock' || sender.frameId !== 0 || !supportedPage.test(sender.url ?? '')) return;
  async function forward() {
    const { port = 8765, token = '' } = await chrome.storage.local.get(['port', 'token']);
    const response = await fetch(`http://127.0.0.1:${port}/v1/watch/clock`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-fullawake-watch': token },
      body: JSON.stringify(message.clock), signal: AbortSignal.timeout(1500), redirect: 'error',
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    await chrome.action.setBadgeText({ tabId: sender.tab.id, text: message.stopped ? '' : message.visualError ? 'CLK' : 'ON' });
    return response.json();
  }
  forward().then(reply, async () => {
    reply({ ok: false });
    await chrome.action.setBadgeText({ tabId: sender.tab.id, text: 'ERR' }).catch(() => {});
  });
  return true;
});

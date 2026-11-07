const form = document.querySelector('form');
const port = document.querySelector('#port');
const token = document.querySelector('#token');
const status = document.querySelector('output');
chrome.storage.local.get(['port', 'token']).then(saved => {
  port.value = saved.port ?? 8765;
  token.value = saved.token ?? '';
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  await chrome.storage.local.set({ port: port.valueAsNumber, token: token.value });
  status.value = '已保存';
});

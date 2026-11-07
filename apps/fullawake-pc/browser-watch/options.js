const form = document.querySelector('form');
const port = document.querySelector('#port');
const token = document.querySelector('#token');
const enabled = document.querySelector('#enabled');
const status = document.querySelector('output');

chrome.storage.local.get(['port', 'token', 'enabled']).then(saved => {
  port.value = saved.port ?? 8765;
  token.value = saved.token ?? '';
  enabled.checked = saved.enabled !== false;
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  await chrome.storage.local.set({
    port: port.valueAsNumber,
    token: token.value,
    enabled: enabled.checked,
  });
  status.value = '已保存';
});

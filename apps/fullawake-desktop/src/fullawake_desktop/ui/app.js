'use strict';

const byId = id => document.getElementById(id);
let api, state = {}, sources = { monitors: [], windows: [] }, selected = { kind: 'auto' }, notified = '', actionPending = false;
let previewGeneration = 0;
let homeOpen = false;
let albumGeneration = 0;
let albumKey;
let home;

function node(tag, value, className) {
  const result = document.createElement(tag);
  if (value !== undefined) result.textContent = value;
  if (className) result.className = className;
  return result;
}

function lamp(id, online, label) {
  const element = byId(id);
  element.textContent = label;
  element.classList.toggle('online', Boolean(online));
}

function feedback(message) {
  byId('feedback').hidden = !message;
  byId('feedback').textContent = message || '';
}

function renderState(next) {
  state = next;
  renderHome(next.home);
  lamp('usb', next.usb, 'USB 隧道 · ' + (next.usb ? '已建立' : '等待'));
  lamp('phone', next.bridge_connected, '手机小满 · ' + (next.bridge_connected ? '已连接' : '等待握手'));
  lamp('gateway', next.gateway_online, 'PC 网关 · ' + (next.gateway_online ? '运行中' : '离线'));
  byId('call').disabled = byId('watch').disabled = byId('sync').disabled = actionPending || !next.desktop_control;
  byId('pet').disabled = actionPending;
  byId('pet').classList.toggle('active', Boolean(next.pet_running));
  byId('pet').textContent = next.pet_running ? '关闭桌宠' : '启动桌宠';
  if (document.activeElement !== byId('auto-pet')) byId('auto-pet').checked = Boolean(next.auto_launch_pet);
  byId('call').classList.toggle('active', Boolean(next.call_active));
  byId('call').lastElementChild.textContent = next.call_active ? '挂断连麦' : '开启连麦';
  byId('watch').classList.toggle('active', Boolean(next.watch_active));
  byId('watch').lastElementChild.textContent = next.watch_active ? '停止陪看' : '开启陪看';
  byId('target-label').textContent = next.target_label || selected.label || '跟随前台窗口所在屏';
  byId('rms').value = next.mic_rms || 0;
  lamp('ptt', next.ptt_active, next.ptt_active ? 'PTT 按下' : 'PTT 未按下');
  byId('asr').textContent = 'ASR · ' + ({ sensevoice: 'SenseVoice', whisper: 'Whisper' }[next.asr_backend] || '待识别');
  if (next.vad_mode && !actionPending && document.activeElement !== byId('mode')) byId('mode').value = next.vad_mode;
  if (next.ptt_key && !actionPending && document.activeElement !== byId('key')) byId('key').value = next.ptt_key;
  byId('key').disabled = next.vad_mode === 'auto';
  byId('mute').textContent = next.muted ? '解除静音' : '静音';
  if (byId('logs').parentElement.open) byId('logs').textContent = (next.logs || []).join('\n');
  if (next.gateway_error || next.usb_error || (next.bridge_connected && !next.desktop_control)) {
    feedback(next.gateway_error || notified || next.usb_error || '手机需要加载 FullAwake 0.2.14。');
  } else feedback(notified);
  const rows = (next.recent_turns || []).slice(-5).reverse().map(turn => {
    const row = node('article', undefined, 'turn');
    if (turn.asr) row.append(node('p', '你 · ' + turn.asr));
    if (turn.reply) row.append(node('p', '小满 · ' + turn.reply));
    row.append(node('small', [['ASR', turn.asr_ms], ['LLM', turn.phone_llm_ms],
      ['音频准备', turn.render_ms], ['总计', turn.total_ms]]
      .filter(([, value]) => Number.isFinite(value)).map(([label, value]) => label + ' ' + value + ' ms').join(' · ')));
    return row;
  });
  byId('turns').replaceChildren(...(rows.length ? rows : [node('p', '连麦后显示识别和回复。', 'muted')]));
}

function renderHome(snapshot) {
  const current = snapshot?.phone_online && !snapshot.stale && Date.parse(snapshot.expiresAt) > Date.now();
  const mood = { calm: '平静', cheerful: '开心', engaged: '专注', excited: '兴奋', tired: '倦了' };
  const label = current ? ['手机在线', mood[snapshot.mood?.state], snapshot.sceneState?.label].filter(Boolean).join(' · ')
    : snapshot?.unavailable === 'expired' || snapshot?.phone_online ? '状态已过期 · 安静等待' : '手机离线 · 安静等待';
  if (byId('home-status').textContent !== label) byId('home-status').textContent = label;
  home?.update(current ? snapshot.sceneState : null);
  const key = current ? snapshot.generatedAt : null;
  if (byId('home-drawer').open && key !== albumKey) void loadAlbum(key);
}

function setView(nextHome) {
  homeOpen = nextHome;
  byId('home-view').hidden = !nextHome;
  byId('workbench-view').hidden = nextHome;
  for (const [id, selected] of [['workbench-tab', !nextHome], ['home-tab', nextHome]]) {
    const tab = byId(id);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  if (!nextHome && byId('home-drawer').open) byId('home-drawer').close();
  if (nextHome) previewGeneration++;
  home.setActive(nextHome);
}

async function loadAlbum(key) {
  albumKey = key;
  const generation = ++albumGeneration;
  const list = byId('home-album-items');
  list.replaceChildren(node('p', key ? '正在读取共同相册…' : '手机离线，相册暂不可用。'));
  if (!key) return;
  let result;
  try { result = await api.home(); } catch {}
  if (generation !== albumGeneration || !byId('home-drawer').open) return;
  if (!result?.phone_online || result.stale || result.generatedAt !== key) {
    list.replaceChildren(node('p', '相册状态正在同步。'));
    return;
  }
  const items = result.recentAlbum || [];
  const kinds = { video_storyboard: '视频', game_moment: '游戏', user_photo: '照片' };
  const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
  const cards = items.map(item => {
    const card = node('article', undefined, 'home-entry');
    const time = Date.parse(item.timestamp);
    card.append(node('h3', item.title), node('p', item.summary), node('small',
      [kinds[item.kind], Number.isFinite(time) ? date.format(time) : '', '修订 ' + item.revision + ' 次'].filter(Boolean).join(' · ')));
    return card;
  });
  list.replaceChildren(...(cards.length ? cards : [node('p', '当前私聊还没有可展示的共同高光。')]));
}

function openAlbum() {
  const drawer = byId('home-drawer');
  if (drawer.open) return;
  drawer.showModal();
  const snapshot = state.home;
  void loadAlbum(snapshot?.phone_online && !snapshot.stale && Date.parse(snapshot.expiresAt) > Date.now()
    ? snapshot.generatedAt : null);
}

function renderSources() {
  byId('auto').classList.toggle('selected', selected.kind === 'auto');
  byId('monitors').replaceChildren(...sources.monitors.map(monitor => {
    const button = node('button', undefined, 'source display');
    button.title = monitor.name;
    button.classList.toggle('selected', selected.kind === 'monitor' && monitor.id === selected.monitor_id);
    if (monitor.thumbnail_data_url?.startsWith('data:image/jpeg;base64,')) {
      const thumbnail = node('img');
      thumbnail.src = monitor.thumbnail_data_url;
      thumbnail.alt = '';
      button.append(thumbnail);
    }
    button.append(node('span', monitor.name), node('small', monitor.width + '×' + monitor.height + (monitor.is_primary ? ' · 主屏' : '')));
    button.onclick = () => select({ kind: 'monitor', monitor_id: monitor.id });
    return button;
  }));
  const term = byId('window-search').value.trim().toLowerCase();
  const list = sources.windows.filter(window => (window.title + ' ' + window.process).toLowerCase().includes(term));
  byId('windows').replaceChildren(new Option('选择窗口', ''), ...list.map(window =>
    new Option(window.title + ' · ' + window.process, String(window.hwnd))));
  byId('windows').value = selected.kind === 'window' ? String(selected.hwnd) : '';
}

async function refreshSources() {
  const result = await api.sources();
  if (!result.error) {
    sources = result;
    selected = result.active_target;
    renderSources();
  }
}

async function preview() {
  const generation = ++previewGeneration;
  const result = await api.preview();
  if (generation !== previewGeneration) return;
  const valid = result.data_url?.startsWith('data:image/jpeg;base64,');
  byId('preview').hidden = !valid;
  if (valid) byId('preview').src = result.data_url;
  else byId('preview').removeAttribute('src');
  byId('preview-empty').hidden = Boolean(valid);
  byId('preview-empty').textContent = result.error || '等待画面';
  byId('backend').textContent = ({ dxcam: 'DXGI', mss: 'MSS' }[result.capture_backend] || '');
  byId('blank').hidden = !result.is_blank;
  byId('blank-description').textContent = result.warning || '';
}

async function run(operation, requireReceipt = false) {
  if (actionPending) return;
  actionPending = true;
  notified = '';
  renderState(state);
  try {
    const response = await operation();
    notified = response.error || (requireReceipt && !response.accepted ? (response.reason || '手机未确认操作。请检查会话绑定、桌宠和 Heart 状态。') : '');
    if (Object.hasOwn(response, 'bridge_connected')) renderState({ ...state, ...response });
    return response;
  } catch {
    notified = '操作未完成。';
  } finally {
    actionPending = false;
    renderState(state);
  }
}

async function select(value) {
  const result = await run(() => api.target(value));
  if (result && !result.error) {
    selected = result;
    renderSources();
    await preview();
  }
}

async function repeat(callback, delay) {
  try { await callback(); } catch { /* The next status request can recover. */ }
  setTimeout(() => repeat(callback, delay), delay);
}

window.addEventListener('pywebviewready', () => {
  api = window.pywebview.api;
  home = window.HomeCanvas.create(byId('home-canvas'), openAlbum);
  for (const [id, selected] of [['workbench-tab', false], ['home-tab', true]]) {
    const tab = byId(id);
    tab.onclick = () => setView(selected);
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? false : event.key === 'End' ? true : !selected;
      setView(next);
      byId(next ? 'home-tab' : 'workbench-tab').focus();
    };
  }
  byId('home-album').onclick = openAlbum;
  byId('home-export').onclick = async () => {
    const button = byId('home-export');
    const hint = byId('home-hint');
    button.disabled = true;
    hint.hidden = true;
    try {
      const result = await api.save_home_image(home.image());
      hint.textContent = result.error || (result.saved ? '已保存小屋画面。' : '');
    } catch {
      hint.textContent = '暂时无法保存小屋画面。';
    } finally {
      hint.hidden = !hint.textContent;
      button.disabled = false;
    }
  };
  byId('home-drawer').addEventListener('close', () => { albumGeneration++; albumKey = undefined; });
  byId('pet').onclick = async () => {
    const res = await run(() => api.toggle_pet(), true);
    if (res?.accepted) {
      notified = res.pet_running ? '桌宠已启动。' : '桌宠已关闭。';
      renderState({ ...state, pet_running: res.pet_running });
    }
  };
  byId('auto-pet').onchange = async event => {
    const res = await run(() => api.set_auto_pet(event.target.checked));
    if (res?.accepted) renderState({ ...state, auto_launch_pet: res.auto_launch_pet });
  };
  byId('sync').onclick = async () => {
    const res = await run(() => api.sync_session(), true);
    if (res?.accepted) { notified = '已同步手机当前活跃私聊会话。'; renderState(state); }
  };
  byId('reconnect').onclick = () => run(() => api.reconnect());
  byId('restart').onclick = () => run(() => api.restart_gateway());
  byId('call').onclick = () => run(() => api.call(!state.call_active), true);
  byId('watch').onclick = () => run(() => api.watch(!state.watch_active), true);
  byId('refresh').onclick = refreshSources;
  byId('auto').onclick = () => select({ kind: 'auto' });
  byId('window-search').oninput = renderSources;
  byId('windows').onchange = event => { if (event.target.value) select({ kind: 'window', hwnd: Number(event.target.value) }); };
  byId('mode').onchange = event => run(() => api.audio({ vad_mode: event.target.value }));
  byId('key').onchange = event => run(() => api.audio({ ptt_key: event.target.value }));
  byId('mute').onclick = () => run(() => api.audio({ muted: !state.muted }));
  void repeat(async () => {
    const next = await api.state();
    if (next.gateway_online && !state.gateway_online) void refreshSources();
    renderState(next);
  }, 300);
  void repeat(async () => { if (state.gateway_online && !homeOpen && !document.hidden) await preview(); }, 1500);
}, { once: true });

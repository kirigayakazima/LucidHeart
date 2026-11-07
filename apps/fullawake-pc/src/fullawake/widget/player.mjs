import { PlaybackMotion } from '/motion.mjs';

const audio = document.querySelector('#audio');
const file = document.querySelector('#file');
const status = document.querySelector('#status');
const motion = new PlaybackMotion();
const token = location.hash.slice(1);
let context;
let analyser;
let samples;
let url;
let utterance;
let socket;
let waiting = false;

function connect() {
  socket = new WebSocket(`ws://${location.host}/clock?token=${encodeURIComponent(token)}`);
  socket.addEventListener('open', () => { status.textContent = '挂件已连接'; });
  socket.addEventListener('close', () => {
    status.textContent = '挂件离线，音频可继续播放';
    setTimeout(connect, 2000);
  });
}

function publish(frame) {
  if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 2048) socket.send(JSON.stringify(frame));
}

file.addEventListener('change', () => {
  const selected = file.files[0];
  if (!selected) return;
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(selected);
  utterance = crypto.randomUUID();
  motion.reset();
  audio.src = url;
});

audio.addEventListener('play', () => {
  if (!context) {
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    samples = new Float32Array(analyser.fftSize);
    context.createMediaElementSource(audio).connect(analyser).connect(context.destination);
  }
  void context.resume();
});

for (const event of ['waiting', 'pause', 'ended', 'seeking']) {
  audio.addEventListener(event, () => {
    waiting = true;
    motion.reset();
    publish({ mode: 'idle' });
  });
}
audio.addEventListener('playing', () => { waiting = false; });
audio.addEventListener('seeked', () => { waiting = false; });

if (token) connect();
else status.textContent = '请使用桌面挂件启动时打印的完整地址';

setInterval(() => {
  if (!analyser || !utterance || audio.paused || waiting || context.state !== 'running') return;
  analyser.getFloatTimeDomainData(samples);
  const audiblePosition = Math.max(0, audio.currentTime - (context.outputLatency ?? 0));
  publish(motion.update(utterance, audiblePosition * 1000, samples));
}, 33);

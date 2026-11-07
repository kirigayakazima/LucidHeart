(() => {
  const key = '__fullawakeWatchClock';
  if (globalThis[key]) {
    globalThis[key]();
    return;
  }
  const source = crypto.randomUUID();
  const canvas = document.createElement('canvas');
  let segment = 0;
  let sequence = 0;
  let identity;
  let video;
  let sample;
  let frameRequest;
  let visualError = false;
  let stopped = false;
  let busy = false;
  let again = false;
  let controlId;
  let controlApplied = false;

  function invalidate() {
    segment++;
    sample = undefined;
    if (frameRequest != null) video?.cancelVideoFrameCallback?.(frameRequest);
    frameRequest = undefined;
  }

  function capture(player) {
    if (frameRequest != null || visualError) return;
    if (typeof player.requestVideoFrameCallback !== 'function') {
      visualError = true;
      return;
    }
    const epoch = segment;
    frameRequest = player.requestVideoFrameCallback((_now, frame) => {
      frameRequest = undefined;
      if (stopped || epoch !== segment || player.paused || player.seeking || document.hidden) return;
      if (!(player.videoWidth > 0 && player.videoHeight > 0)) return;
      canvas.width = Math.min(384, player.videoWidth);
      canvas.height = Math.max(1, Math.min(384, Math.round(canvas.width * player.videoHeight / player.videoWidth)));
      try {
        canvas.getContext('2d', { alpha: false }).drawImage(player, 0, 0, canvas.width, canvas.height);
        sample = { mediaTime: frame.mediaTime, jpeg: canvas.toDataURL('image/jpeg', 0.74).split(',')[1] };
      } catch {
        visualError = true;
      }
    });
  }

  function subtitles(player, end) {
    const cues = [];
    for (const track of player.textTracks) {
      if (!['subtitles', 'captions'].includes(track.kind) || track.mode !== 'showing' || !track.cues) continue;
      for (let i = track.cues.length - 1; i >= 0 && cues.length < 24; i--) {
        const cue = track.cues[i];
        if (cue.endTime < end - 30) break;
        if (cue.endTime <= end && typeof cue.text === 'string' && cue.text.trim()) {
          cues.push({ start: cue.startTime, end: cue.endTime, text: cue.text.slice(0, 280) });
        }
      }
    }
    return cues.reverse();
  }

  function seek() {
    invalidate();
    void tick();
  }

  function detach() {
    video?.removeEventListener('seeking', seek);
    video?.removeEventListener('seeked', seek);
    video?.removeEventListener('pause', tick);
    delete globalThis[key];
  }

  async function tick() {
    if (busy) { again = true; return; }
    const match = /^\/video\/(BV[a-zA-Z0-9]+)/.exec(location.pathname);
    const player = document.querySelector('#bilibili-player video, .bpx-player-video-wrap video, video');
    if (!match || !player || !Number.isFinite(player.duration) || player.duration <= 0) {
      if (stopped) detach();
      return;
    }
    const part = new URL(location.href).searchParams.get('p');
    const videoId = match[1] + (part && /^\d+$/.test(part) ? `_p${part}` : '');
    const next = `${videoId} ${player.currentSrc}`;
    if (video !== player || next !== identity) {
      invalidate();
      visualError = false;
      video?.removeEventListener('seeking', seek);
      video?.removeEventListener('seeked', seek);
      video?.removeEventListener('pause', tick);
      video = player;
      identity = next;
      video.addEventListener('seeking', seek);
      video.addEventListener('seeked', seek);
      video.addEventListener('pause', tick);
    }
    const at = Math.min(player.currentTime, player.duration);
    const paused = stopped || player.paused || document.hidden || player.ended || player.readyState < 2;
    const clock = { client: 'bilibili-web-player', source, segment, sequence: ++sequence, videoId,
      title: document.title.slice(0, 240), playbackPositionSec: at, durationSec: player.duration,
      paused, stopped, seeking: player.seeking, speed: player.playbackRate, subtitles: stopped ? [] : subtitles(player, at),
      controlId: controlId ?? null, controlApplied };
    if (!paused && !clock.seeking) {
      if (sample && sample.mediaTime <= at && at - sample.mediaTime <= 1.5) clock.frame = sample;
      sample = undefined;
      capture(player);
    }
    busy = true;
    try {
      const result = await chrome.runtime.sendMessage({ kind: 'watch-clock', clock, visualError, stopped });
      const command = result?.command;
      if (!stopped && command && command.id !== controlId && clock.segment === segment && video === player) {
        controlId = command.id;
        try {
          if (command.action === 'play') await player.play();
          else player.pause();
          controlApplied = true;
        } catch { controlApplied = false; }
        again = true;
      }
    } catch {
      // Extension reload or transport failure leaves the gateway to expire the clock.
    } finally {
      busy = false;
      if (again) { again = false; void tick(); }
      else if (stopped) detach();
    }
  }

  const timer = setInterval(tick, 1000);
  document.addEventListener('visibilitychange', tick);
  globalThis[key] = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
    invalidate();
    void tick();
  };
  void tick();
})();

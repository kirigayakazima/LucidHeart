'use strict';

(() => {
  const width = 1600, height = 900;
  // Pixel-accurate anchor coordinates (feet / rest center) on the 1600x900 illustrated room.
  const places = {
    window: [795, 678],
    sofa: [355, 760],
    desk: [1150, 682],
    computer: [1205, 672],
    bookshelf: [177, 605],
    bed: [1250, 792],
    door: [1395, 702],
  };

  // Bookshelf / photo album clickable region on the upper-left wall.
  const ALBUM_RECT = { x: 14, y: 120, w: 266, h: 228 };
  const HOTSPOTS = {
    lamp: { x: 1038, y: 291, w: 100, h: 126 },
    album: ALBUM_RECT,
    sofa: { x: 105, y: 642, w: 392, h: 157 },
    desk: { x: 1030, y: 449, w: 300, h: 236 },
    window: { x: 576, y: 225, w: 435, h: 370 },
    bed: { x: 1040, y: 731, w: 510, h: 133 },
    floor: { x: 64, y: 603, w: 1472, h: 254 },
  };
  const FURNITURE_POSES = { sofa: 'sit', window: 'idle', desk: 'sit', bed: 'sit', floor: 'idle' };
  const MOOD_LINES = { cheerful: '嘿嘿，被你摸头啦～', tired: '唔……再让我靠一会儿嘛' };
  const OFFLINE = { place: 'window', pose: 'idle', source: 'offline', label: '安静等待' };

  // Window fairy light bulb positions along the curtain rod for live twinkling at night.
  const FAIRY_LIGHTS = [
    [590, 128], [625, 138], [662, 146], [700, 149], [738, 142],
    [775, 125], [818, 125], [856, 140], [895, 147], [935, 145], [972, 136], [1005, 126],
  ];

  // Precomputed drifting dust motes for warm daytime sunbeams / lamp airiness.
  const MOTES = Array.from({ length: 22 }, (_, i) => ({
    x: 560 + ((i * 73) % 520),
    y: 220 + ((i * 59) % 440),
    r: 1.4 + (i % 3) * 0.7,
    speed: 0.25 + (i % 5) * 0.08,
    phase: i * 1.37,
  }));

  function loadImage(src) {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    return img;
  }

  function ready(img) {
    return Boolean(img && img.complete && img.naturalWidth > 0);
  }

  // Smoothly compute night blend factor [0 = full daytime, 1 = full night] from local hour.
  function nightFactor(hour) {
    if (hour >= 20.5 || hour < 5.0) return 1;
    if (hour >= 8.5 && hour < 17.0) return 0;
    if (hour >= 5.0 && hour < 8.5) return 1 - (hour - 5.0) / 3.5;
    return (hour - 17.0) / 3.5;
  }

  function create(canvas, onAlbum, onLamp = () => {}) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const scale = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);

    const bgDay = loadImage('home_room_day.jpg');
    const bgNight = loadImage('home_room_night.jpg');
    const sprites = {
      idle: loadImage('sprites/xiaoman_idle.png'),
      walk: loadImage('sprites/xiaoman_walk.png'),
      read: loadImage('sprites/xiaoman_read.png'),
      rest: loadImage('sprites/xiaoman_rest.png'),
      snack: loadImage('sprites/xiaoman_snack.png'),
      play: loadImage('sprites/xiaoman_play.png'),
      happy: loadImage('sprites/xiaoman_happy.png'),
    };

    let active = false, frame = null, paintedAt = -Infinity;
    let state = OFFLINE, speech, mood, presence;
    let localOverride = null, lampManual = null, hover = null;
    let position = places.window, from = position, destination = position, movedAt = 0;
    let facing = 1; // 1 = normal, -1 = flipped horizontally

    function move(next, at) {
      if (next[0] === destination[0] && next[1] === destination[1]) return;
      destination = next;
      [from, movedAt] = [active ? position : next, at];
    }

    function resetLocal(at) {
      localOverride = null;
      move(places[state.place], at);
    }

    function actualSpeech() {
      return speech?.text && Date.parse(speech.expiresAt) > Date.now() ? speech.text : '';
    }

    const triggerPaint = () => {
      if (active && !document.hidden) draw(performance.now());
    };
    for (const img of [bgDay, bgNight, ...Object.values(sprites)]) {
      img.addEventListener('load', triggerPaint, { once: true });
    }

    function drawFallbackRoom(night) {
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, night > 0.5 ? '#231d36' : '#4a3d5f');
      grad.addColorStop(1, night > 0.5 ? '#181426' : '#2d233a');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    }

    function drawBackdrop(hour, seconds) {
      const night = nightFactor(hour);
      const hasDay = ready(bgDay), hasNight = ready(bgNight);
      if (hasDay && hasNight) {
        ctx.globalAlpha = 1;
        ctx.drawImage(bgDay, 0, 0, width, height);
        if (night > 0.01) {
          ctx.globalAlpha = night;
          ctx.drawImage(bgNight, 0, 0, width, height);
          ctx.globalAlpha = 1;
        }
      } else if (hasNight) {
        ctx.drawImage(bgNight, 0, 0, width, height);
      } else if (hasDay) {
        ctx.drawImage(bgDay, 0, 0, width, height);
      } else {
        drawFallbackRoom(night);
      }

      // Live ambient lighting overlays
      if (night > 0.2) {
        // Twinkling fairy lights along the curtain rod
        for (let i = 0; i < FAIRY_LIGHTS.length; i++) {
          const [fx, fy] = FAIRY_LIGHTS[i];
          const twinkle = 0.55 + 0.45 * Math.sin(seconds * 2.1 + i * 1.15);
          const alpha = night * twinkle * 0.55;
          const g = ctx.createRadialGradient(fx, fy, 1, fx, fy, 20);
          g.addColorStop(0, `rgba(255, 232, 168, ${alpha})`);
          g.addColorStop(1, 'rgba(255, 210, 120, 0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(fx, fy, 20, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const lampStrength = lampManual === null ? night : Number(lampManual);
      if (lampStrength > 0.01) {
        const lampPulse = 0.88 + 0.12 * Math.sin(seconds * 1.4);
        const lamp = ctx.createRadialGradient(1088, 370, 12, 1088, 395, 210);
        lamp.addColorStop(0, `rgba(255, 215, 138, ${0.26 * lampStrength * lampPulse})`);
        lamp.addColorStop(1, 'rgba(255, 195, 110, 0)');
        ctx.fillStyle = lamp;
        ctx.fillRect(860, 180, 460, 420);
      }

      // Animated TV glow when Xiaoman is watching movies/videos on the sofa
      if (state.pose === 'watch') {
        const flicker = 0.78 + 0.22 * Math.sin(seconds * 3.7) * Math.cos(seconds * 1.9);
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(300, 355, 224, 140, 6);
        const tvScreen = ctx.createLinearGradient(300, 355, 524, 495);
        tvScreen.addColorStop(0, `rgba(128, 178, 255, ${0.28 * flicker})`);
        tvScreen.addColorStop(0.5, `rgba(196, 158, 255, ${0.22 * flicker})`);
        tvScreen.addColorStop(1, `rgba(110, 210, 225, ${0.26 * flicker})`);
        ctx.fillStyle = tvScreen;
        ctx.fill();
        const spill = ctx.createRadialGradient(412, 430, 30, 412, 470, 260);
        spill.addColorStop(0, `rgba(155, 190, 255, ${0.18 * flicker})`);
        spill.addColorStop(1, 'rgba(155, 190, 255, 0)');
        ctx.fillStyle = spill;
        ctx.fillRect(150, 220, 520, 480);
        ctx.restore();
      }

      // Softly drifting golden dust motes in the sunbeams / warm air
      const moteAlphaBase = night < 0.5 ? 0.38 : 0.16;
      for (const m of MOTES) {
        const mx = m.x + Math.sin(seconds * m.speed + m.phase) * 18;
        const my = m.y + Math.cos(seconds * m.speed * 0.8 + m.phase) * 14;
        const pulse = 0.5 + 0.5 * Math.sin(seconds * 1.6 + m.phase);
        ctx.fillStyle = `rgba(255, 238, 196, ${(moteAlphaBase * pulse).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(mx, my, m.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Subtle warm highlight when hovering the bookshelf (共同相册)
      const highlight = hover === 'pet' ? characterRect() : HOTSPOTS[hover];
      if (highlight && hover !== 'floor') {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 226, 168, 0.42)';
        ctx.lineWidth = 2;
        ctx.fillStyle = 'rgba(255, 226, 168, 0.06)';
        ctx.beginPath();
        ctx.roundRect(highlight.x, highlight.y, highlight.w, highlight.h, 18);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    function pickSpriteSheet(pose) {
      if (['snack', 'play', 'happy'].includes(pose) && ready(sprites[pose])) return sprites[pose];
      if (pose === 'walk' && ready(sprites.walk)) return sprites.walk;
      if (pose === 'rest' && ready(sprites.rest)) return sprites.rest;
      if ((pose === 'read' || pose === 'sit') && ready(sprites.read)) return sprites.read;
      if (ready(sprites.idle)) return sprites.idle;
      return null;
    }

    function drawXiaoman(x, y, pose, seconds, speaking) {
      ctx.save();
      ctx.translate(x, y);

      // Soft ground contact shadow
      const shadowW = pose === 'rest' ? 68 : 54;
      const shadowGrad = ctx.createRadialGradient(0, 0, 4, 0, 0, shadowW);
      shadowGrad.addColorStop(0, 'rgba(18, 12, 28, 0.44)');
      shadowGrad.addColorStop(1, 'rgba(18, 12, 28, 0)');
      ctx.fillStyle = shadowGrad;
      ctx.beginPath();
      ctx.ellipse(0, 0, shadowW, 14, 0, 0, Math.PI * 2);
      ctx.fill();

      const sheet = pickSpriteSheet(pose);
      if (sheet) {
        const frameCount = 8;
        const cellW = sheet.naturalWidth / frameCount;
        const cellH = sheet.naturalHeight;
        const fps = pose === 'walk' || speaking ? 9 : pose === 'rest' ? 4 : 6;
        const idx = Math.floor(seconds * fps) % frameCount;
        const drawSize = pose === 'rest' ? 215 : 235;
        const bob = pose === 'walk' || pose === 'happy' ? -Math.abs(Math.sin(seconds * 11)) * 7
          : Math.sin(seconds * (speaking ? 5 : 2)) * (speaking ? 3 : 1.8);

        ctx.save();
        ctx.translate(0, bob);
        if (facing < 0 && pose === 'walk') ctx.scale(-1, 1);
        ctx.drawImage(sheet, idx * cellW, 0, cellW, cellH, -drawSize / 2, -drawSize + 18, drawSize, drawSize);
        ctx.restore();
      } else {
        // Minimal clean fallback while sprites load
        ctx.fillStyle = '#7ea8ff';
        ctx.beginPath();
        ctx.arc(0, -68, 36, 0, Math.PI * 2);
        ctx.fill();
      }

      // Gentle floating status indicator (sleep Zzz or cheerful note)
      if (pose === 'rest') {
        const rise = (seconds * 18) % 36;
        const alpha = Math.sin((rise / 36) * Math.PI) * 0.85;
        ctx.fillStyle = `rgba(218, 224, 255, ${alpha.toFixed(2)})`;
        ctx.font = '700 22px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('zZz', 42, -165 - rise);
      } else if (state.pose === 'watch' || state.place === 'sofa') {
        const floatY = Math.sin(seconds * 2.4) * 5;
        ctx.fillStyle = 'rgba(255, 226, 175, 0.78)';
        ctx.font = '600 18px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('✦', 56, -188 + floatY);
      }

      ctx.restore();
    }

    function drawBubble(text, x, y, alpha = 1) {
      ctx.save();
      ctx.font = '600 26px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      const rows = [''];
      const characters = [...text.replace(/\s+/gu, ' ')];
      for (const char of characters) {
        const last = rows.length - 1;
        if (ctx.measureText(rows[last] + char).width > 422) {
          if (rows.length === 3) {
            const final = [...rows[last]];
            while (ctx.measureText(final.join('') + '…').width > 422) final.pop();
            rows[last] = final.join('') + '…';
            break;
          }
          rows.push(char);
        } else rows[last] += char;
      }
      const w = Math.max(86, ...rows.map(row => ctx.measureText(row).width + 38));
      const h = rows.length * 34 + 21;
      const left = Math.max(16, Math.min(width - w - 16, x - w / 2));
      const top = Math.max(16, y - h);
      const tail = Math.max(left + 22, Math.min(left + w - 22, x));
      ctx.globalAlpha = alpha;
      const glass = ctx.createLinearGradient(0, top, 0, top + h);
      glass.addColorStop(0, '#28243eed');
      glass.addColorStop(1, '#4f395ceb');
      ctx.fillStyle = glass;
      ctx.strokeStyle = '#e8d5efab';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(left, top, w, h, 19);
      ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tail - 8, top + h - 1);
      ctx.lineTo(tail + 8, top + h - 1); ctx.lineTo(tail, top + h + 12);
      ctx.closePath(); ctx.fill();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff7f5';
      rows.forEach((row, index) => ctx.fillText(row, left + w / 2, top + 28 + index * 34));
      ctx.restore();
    }

    function drawOverlay(at, words) {
      const [x, y] = position;
      if (words) drawBubble(words, x, y - 221);
      else if (state.source === 'session' && state.label?.includes('想')) {
        drawBubble(Array.from({ length: 1 + Math.floor(at / 350) % 3 }, () => '·').join(' '), x, y - 221);
      } else if (localOverride?.line && at - localOverride.startedAt < 3500) {
        const age = at - localOverride.startedAt;
        drawBubble(localOverride.line, x, y - 221, Math.min(1, (3500 - age) / 600));
      }
      if (localOverride?.hearts && at - localOverride.startedAt < 1500) {
        const age = (at - localOverride.startedAt) / 1500;
        ctx.save();
        ctx.globalAlpha = 1 - age;
        ctx.font = '700 27px "Segoe UI Symbol", sans-serif';
        ctx.fillStyle = '#ffc4de';
        [-46, 0, 46].forEach((offset, index) => {
          ctx.fillText('♡', x + offset * (1 + age), y - 124 - age * (60 + 19 * index));
        });
        ctx.restore();
      }
    }

    function draw(at) {
      const now = new Date();
      ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      const hour = now.getHours() + now.getMinutes() / 60;
      const seconds = at / 1000;

      if (localOverride && localOverride.expiresAt <= at) resetLocal(at);
      const words = actualSpeech();
      drawBackdrop(hour, seconds);

      const progress = Math.min(1, Math.max(0, (at - movedAt) / 1050));
      const curve = progress * progress * (3 - 2 * progress);
      position = from.map((value, index) => value + (destination[index] - value) * curve);
      const moving = progress < 1 && from !== destination;
      if (moving && Math.abs(destination[0] - from[0]) > 2) {
        facing = destination[0] < from[0] ? 1 : -1;
      }

      const localPose = localOverride && at < (localOverride.poseUntil ?? localOverride.expiresAt) ? localOverride.pose : null;
      drawXiaoman(position[0], position[1], moving ? 'walk' : localPose || state.pose, seconds, Boolean(words));

      // Soft nocturnal / rest atmospheric veil
      const restDim = state.pose === 'rest' ? 0.14 : 0;
      if (restDim > 0) {
        ctx.fillStyle = `rgba(18, 16, 36, ${restDim})`;
        ctx.fillRect(0, 0, width, height);
      }
      if (state.source === 'offline') {
        ctx.fillStyle = 'rgba(24, 22, 38, 0.18)';
        ctx.fillRect(0, 0, width, height);
      }
      drawOverlay(at, words);
    }

    function tick(at) {
      frame = null;
      if (!active || document.hidden) return;
      if (at - paintedAt >= 32) {
        draw(at);
        paintedAt = at;
      }
      frame = requestAnimationFrame(tick);
    }

    function syncVisibility() {
      if (active && !document.hidden) {
        if (frame === null) frame = requestAnimationFrame(tick);
      } else if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    }

    function characterRect() {
      const [x, y] = position;
      return { x: x - 72, y: y - 200, w: 144, h: 208 };
    }

    function pointer(event) {
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return null;
      const x = (event.clientX - bounds.left) * width / bounds.width;
      const y = (event.clientY - bounds.top) * height / bounds.height;
      const inside = rect => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
      const kind = inside(characterRect()) ? 'pet' : Object.keys(HOTSPOTS).find(key => inside(HOTSPOTS[key]));
      return { kind, point: [x, y] };
    }

    function interact(action, point) {
      if (action === 'lamp') {
        lampManual = lampManual === null ? true : lampManual ? false : null;
        onLamp(lampManual === null ? 'auto' : lampManual ? 'on' : 'off');
        return;
      }
      if (action === 'album') { onAlbum(); return; }
      if (actualSpeech() || ['session', 'pc', 'companion'].includes(state.source)) return;
      const at = performance.now();
      if (Object.hasOwn(FURNITURE_POSES, action)) {
        if (presence === 'asleep') return;
        localOverride = { pose: FURNITURE_POSES[action], startedAt: at, expiresAt: at + 30_000 };
        move(action === 'floor' ? point : places[action], at);
      } else if (action === 'pet') {
        const asleep = presence === 'asleep';
        localOverride = { pose: asleep ? 'rest' : 'happy', startedAt: at, expiresAt: at + 3500, poseUntil: at + 2500,
          line: asleep ? 'zzZ……（轻声翻了个身）' : MOOD_LINES[mood] || '在呢，怎么啦？', hearts: true };
        move(position, at);
      } else if ((action === 'snack' || action === 'play') && presence !== 'asleep') {
        localOverride = { pose: action, startedAt: at, expiresAt: at + 6000,
          line: action === 'snack' ? '西瓜好甜！' : '差最后一面啦～' };
        move(position, at);
      }
    }

    document.addEventListener('visibilitychange', syncVisibility);
    canvas.addEventListener('mousemove', event => {
      hover = pointer(event)?.kind;
      canvas.classList.toggle('is-interactive', Boolean(hover));
    });
    canvas.addEventListener('mouseleave', () => {
      hover = null;
      canvas.classList.remove('is-interactive');
    });
    canvas.addEventListener('click', event => {
      const hit = pointer(event);
      if (hit?.kind) interact(hit.kind, hit.point);
    });

    return {
      update(scene, details = {}) {
        const next = scene && Object.hasOwn(places, scene.place) ? scene : OFFLINE;
        const changed = ['place', 'pose', 'source', 'label'].some(key => state[key] !== next[key]);
        state = next;
        ({ speech, mood, presence } = details);
        if (changed || (localOverride && actualSpeech())) resetLocal(performance.now());
      },
      interact,
      setActive(value) { active = value; syncVisibility(); },
      image() {
        draw(performance.now());
        return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
      },
    };
  }

  window.HomeCanvas = { create };
})();

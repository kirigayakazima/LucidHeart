'use strict';

(() => {
  const width = 1600, height = 900;
  // Pixel-accurate anchor coordinates (feet / rest center) on the 1600x900 illustrated room.
  const places = {
    window: [795, 678],
    sofa: [355, 760],
    desk: [1150, 682],
    computer: [1205, 672],
    bed: [1250, 792],
    door: [1395, 702],
  };

  // Bookshelf / photo album clickable region on the upper-left wall.
  const ALBUM_RECT = { x: 14, y: 120, w: 266, h: 228 };

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

  function create(canvas, onAlbum) {
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
    };

    let active = false, frame = null, paintedAt = -Infinity;
    let state = { place: 'window', pose: 'idle', source: 'offline' };
    let position = places.window, from = position, destination = position, movedAt = 0;
    let facing = 1; // 1 = normal, -1 = flipped horizontally
    let hoverAlbum = false;

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
        // Soft pulsing warm desk lamp halo
        const lampPulse = 0.88 + 0.12 * Math.sin(seconds * 1.4);
        const lamp = ctx.createRadialGradient(1088, 370, 12, 1088, 395, 210);
        lamp.addColorStop(0, `rgba(255, 215, 138, ${0.22 * night * lampPulse})`);
        lamp.addColorStop(1, 'rgba(255, 195, 110, 0)');
        ctx.fillStyle = lamp;
        ctx.fillRect(860, 180, 460, 420);
      }

      // Animated TV glow when Xiaoman is watching movies/videos on the sofa
      if (state.place === 'sofa' || state.pose === 'watch') {
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
      if (hoverAlbum) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 226, 168, 0.78)';
        ctx.lineWidth = 3;
        ctx.fillStyle = 'rgba(255, 226, 168, 0.10)';
        ctx.beginPath();
        ctx.roundRect(ALBUM_RECT.x, ALBUM_RECT.y, ALBUM_RECT.w, ALBUM_RECT.h, 12);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(20, 18, 32, 0.82)';
        ctx.beginPath();
        ctx.roundRect(ALBUM_RECT.x + 52, ALBUM_RECT.y + ALBUM_RECT.h + 10, 162, 32, 16);
        ctx.fill();
        ctx.fillStyle = '#f8e9cc';
        ctx.font = '600 14px "Segoe UI", "Microsoft YaHei UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('点击查看共同相册', ALBUM_RECT.x + 133, ALBUM_RECT.y + ALBUM_RECT.h + 31);
        ctx.restore();
      }
    }

    function pickSpriteSheet(pose) {
      if (pose === 'walk' && ready(sprites.walk)) return sprites.walk;
      if (pose === 'rest' && ready(sprites.rest)) return sprites.rest;
      if ((pose === 'read' || pose === 'sit') && ready(sprites.read)) return sprites.read;
      if (ready(sprites.idle)) return sprites.idle;
      return null;
    }

    function drawXiaoman(x, y, pose, seconds) {
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
        const fps = pose === 'walk' ? 9 : pose === 'rest' ? 4 : 6;
        const idx = Math.floor(seconds * fps) % frameCount;
        const drawSize = pose === 'rest' ? 215 : 235;
        const bob = pose === 'walk' ? -Math.abs(Math.sin(seconds * 11)) * 6 : Math.sin(seconds * 2.0) * 1.8;

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

    function draw(at) {
      const now = new Date();
      ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      const hour = now.getHours() + now.getMinutes() / 60;
      const seconds = at / 1000;

      drawBackdrop(hour, seconds);

      const progress = Math.min(1, Math.max(0, (at - movedAt) / 1050));
      const curve = progress * progress * (3 - 2 * progress);
      position = from.map((value, index) => value + (destination[index] - value) * curve);
      const moving = progress < 1 && from !== destination;
      if (moving && Math.abs(destination[0] - from[0]) > 2) {
        facing = destination[0] < from[0] ? 1 : -1;
      }

      drawXiaoman(position[0], position[1], moving ? 'walk' : state.pose, seconds);

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

    function pointerInAlbum(event) {
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return false;
      const x = (event.clientX - bounds.left) * width / bounds.width;
      const y = (event.clientY - bounds.top) * height / bounds.height;
      return x >= ALBUM_RECT.x && x <= ALBUM_RECT.x + ALBUM_RECT.w &&
        y >= ALBUM_RECT.y && y <= ALBUM_RECT.y + ALBUM_RECT.h;
    }

    document.addEventListener('visibilitychange', syncVisibility);
    canvas.addEventListener('mousemove', event => {
      const next = pointerInAlbum(event);
      if (next !== hoverAlbum) {
        hoverAlbum = next;
        canvas.style.cursor = next ? 'pointer' : 'default';
      }
    });
    canvas.addEventListener('mouseleave', () => {
      hoverAlbum = false;
      canvas.style.cursor = 'default';
    });
    canvas.addEventListener('click', event => {
      if (pointerInAlbum(event)) onAlbum();
    });

    return {
      update(scene) {
        state = scene && Object.hasOwn(places, scene.place) ? scene : { place: 'window', pose: 'idle', source: 'offline' };
        const next = places[state.place];
        if (next !== destination) {
          destination = next;
          [from, movedAt] = [active ? position : next, performance.now()];
        }
      },
      setActive(value) { active = value; syncVisibility(); },
      image() {
        draw(performance.now());
        return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
      },
    };
  }

  window.HomeCanvas = { create };
})();

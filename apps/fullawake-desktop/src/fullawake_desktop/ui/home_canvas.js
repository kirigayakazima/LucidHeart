'use strict';

(() => {
  const width = 960, height = 560;
  const places = {
    window: [462, 390], sofa: [185, 421], desk: [635, 400], computer: [736, 400], bed: [791, 473], door: [872, 341],
  };
  const light = [
    [0, [40, 41, 83], [104, 94, 150]], [5, [62, 65, 120], [211, 139, 128]],
    [8, [116, 174, 193], [255, 218, 177]], [15, [126, 174, 192], [255, 226, 182]],
    [19, [99, 94, 149], [247, 165, 126]], [22, [40, 41, 83], [104, 94, 150]],
    [24, [40, 41, 83], [104, 94, 150]],
  ];
  const paletteAt = hour => {
    const end = light.findIndex(([time]) => hour < time);
    const start = light[end - 1], next = light[end];
    const amount = (hour - start[0]) / (next[0] - start[0]);
    return [1, 2].map(index => 'rgb(' + start[index].map((channel, component) =>
      Math.round(channel + (next[index][component] - channel) * amount)).join(',') + ')');
  };

  function create(canvas, onAlbum) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const scale = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    let active = false, frame = null, paintedAt = -Infinity;
    let state = { place: 'window', pose: 'idle', source: 'offline' };
    let position = places.window, from = position, destination = position, movedAt = 0;

    const round = (x, y, w, h, radius, color) => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill();
    };
    const ellipse = (x, y, rx, ry, color) => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, 2 * Math.PI); ctx.fill();
    };
    const line = (points, color, weight = 1) => {
      ctx.strokeStyle = color; ctx.lineWidth = weight; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.stroke();
    };
    const shape = (points, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.closePath(); ctx.fill();
    };

    function windowView(hour, seconds) {
      round(338, 61, 242, 226, 16, '#372b44');
      ctx.save();
      ctx.beginPath(); ctx.roundRect(351, 75, 216, 195, 8); ctx.clip();
      const sky = ctx.createLinearGradient(0, 75, 0, 270);
      const [top, bottom] = paletteAt(hour);
      sky.addColorStop(0, top); sky.addColorStop(1, bottom);
      ctx.fillStyle = sky; ctx.fillRect(351, 75, 216, 195);
      const dark = hour < 6 || hour >= 19;
      if (dark) {
        for (let i = 0; i < 24; i++) {
          ellipse(358 + (i * 59) % 200, 82 + (i * 37) % 91, 1.2, 1.2,
            'rgba(255,244,203,' + (.4 + Math.sin(i + seconds / 2) * .23) + ')');
        }
      }
      const orbX = 387 + ((hour + (dark ? 6 : 0)) % 12) * 10;
      ellipse(orbX, 130, 28, 28, '#ffdeb34a');
      ellipse(orbX, 130, 18, 18, dark ? '#f5e6cb' : '#fff2c2');
      shape([[345, 235], [389, 203], [430, 216], [488, 171], [530, 203], [571, 190], [571, 275], [345, 275]], '#605d86');
      shape([[345, 250], [405, 222], [461, 241], [517, 212], [571, 232], [571, 275], [345, 275]], '#454b69');
      for (let i = 0; i < 13; i++) {
        const x = 347 + i * 18, y = 255 - (i * 13) % 17;
        shape([[x - 13, 278], [x, y - 19], [x + 12, 278]], '#36465b');
      }
      ctx.restore();
      line([[459, 76], [459, 270]], '#372b44', 10);
      line([[353, 177], [566, 177]], '#372b44', 7);
      round(329, 271, 260, 15, 6, '#ca927b');
      round(327, 61, 14, 219, 6, '#a36378');
      round(576, 61, 14, 219, 6, '#a36378');
      line([[330, 59], [587, 59]], '#e2b19a', 5);
    }

    function room(hour, seconds) {
      const wall = ctx.createLinearGradient(0, 0, 0, 357);
      wall.addColorStop(0, '#3c304b'); wall.addColorStop(1, '#79546a');
      ctx.fillStyle = wall; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#413043'; ctx.fillRect(0, 307, width, 43);
      ctx.fillStyle = '#a97977'; ctx.fillRect(0, 342, width, 7);
      const floor = ctx.createLinearGradient(0, 350, 0, height);
      floor.addColorStop(0, '#76515a'); floor.addColorStop(1, '#463641');
      ctx.fillStyle = floor; ctx.fillRect(0, 349, width, height - 349);
      for (let i = -2; i < 13; i++) line([[480 + (i - 4) * 76, 352], [480 + (i - 4) * 125, 560]], '#2e22394f', 2);
      for (const y of [371, 402, 454, 518]) line([[0, y], [960, y]], '#2e223943', 2);

      windowView(hour, seconds);
      round(809, 99, 112, 247, 15, '#382b42');
      round(819, 110, 92, 233, 11, '#69495e');
      round(832, 128, 65, 86, 7, '#805669');
      round(832, 226, 65, 99, 7, '#795167');
      ellipse(893, 224, 5, 5, '#f1bd8d');
      round(831, 350, 84, 19, 9, '#976476');
      line([[847, 358], [900, 358]], '#d19a9b', 2);

      // Bookshelf / album, separate from the television alcove.
      round(93, 84, 156, 115, 10, '#423045');
      round(103, 94, 136, 94, 5, '#664259');
      for (const [x, size, color] of [[115, 56, '#d99473'], [135, 63, '#7aa7a0'], [155, 48, '#caa1b0'], [173, 59, '#b97d89']]) {
        round(x, 182 - size, 15, size, 2, color);
        line([[x + 3, 170], [x + 11, 170]], '#eee0c0', 2);
      }
      round(193, 120, 33, 53, 5, '#704d76');
      round(201, 135, 17, 20, 2, '#e4b592');
      ellipse(209, 145, 4, 4, '#b36e78');
      round(88, 181, 166, 12, 5, '#c08376');

      round(64, 219, 171, 83, 12, '#342b43');
      round(72, 227, 155, 64, 7, '#4c5275');
      shape([[72, 275], [122, 253], [161, 270], [223, 241], [227, 291], [72, 291]], '#656789');
      ellipse(194, 244, 10, 10, '#e5b99e');
      round(67, 300, 170, 15, 6, '#aa756e');
      round(89, 314, 11, 25, 4, '#422d45'); round(210, 314, 11, 25, 4, '#422d45');

      round(313, 317, 270, 29, 12, '#46334b');
      round(321, 317, 255, 9, 4, '#cb957c');
      for (const [x, color] of [[347, '#678983'], [535, '#729584']]) {
        ellipse(x, 291, 15, 18, color);
        ellipse(x - 13, 297, 12, 7, '#61847d');
        ellipse(x + 12, 286, 11, 6, '#8ba794');
        shape([[x - 13, 301], [x + 13, 301], [x + 8, 319], [x - 8, 319]], '#dd9b83');
      }

      ellipse(271, 452, 222, 57, '#b17987');
      ellipse(271, 452, 200, 48, '#c99097');
      ellipse(271, 452, 175, 39, '#bd8291');
      round(73, 356, 218, 74, 22, '#845768');
      round(80, 349, 203, 61, 20, '#b77d8a');
      round(87, 391, 184, 35, 13, '#d69a9c');
      round(71, 378, 33, 54, 13, '#a3677d'); round(267, 378, 33, 54, 13, '#a3677d');
      round(115, 363, 38, 36, 9, '#e4a47e'); round(223, 361, 32, 36, 8, '#8fa2a4');
      line([[171, 397], [171, 424]], '#b77988', 2);
      round(72, 433, 15, 14, 4, '#493546'); round(273, 433, 15, 14, 4, '#493546');

      round(617, 291, 154, 12, 5, '#dca483');
      round(610, 302, 168, 22, 7, '#9c6264');
      round(621, 322, 14, 62, 4, '#593d50'); round(752, 322, 14, 62, 4, '#593d50');
      round(701, 232, 59, 47, 6, '#382e47'); round(707, 238, 47, 31, 3, '#7d91aa');
      round(728, 274, 7, 14, 2, '#3c2e46'); round(714, 286, 36, 5, 2, '#53415b');
      round(628, 284, 25, 7, 3, '#6b4c60');
      line([[643, 285], [643, 238], [657, 226]], '#e5b187', 4);
      shape([[646, 238], [652, 218], [672, 218], [681, 238]], '#f2ba8b');
      const lamp = ctx.createRadialGradient(664, 237, 4, 664, 237, 120);
      lamp.addColorStop(0, '#ffd3a449'); lamp.addColorStop(1, '#ffd3a400');
      ctx.fillStyle = lamp; ctx.fillRect(534, 112, 250, 250);

      round(702, 406, 177, 87, 19, '#513a52');
      round(703, 395, 179, 84, 18, '#bc8d98');
      round(706, 396, 177, 33, 15, '#e0b2ac');
      round(726, 403, 67, 37, 12, '#f4cec0');
      round(714, 431, 165, 49, 13, '#8e7ba4');
      line([[721, 445], [870, 445]], '#bba3bd', 2);
      line([[721, 457], [870, 457]], '#bba3bd', 2);
      for (const x of [732, 769, 806, 843]) line([[x, 432], [x, 475]], '#a58cb2', 2);
    }

    function xiaoman(x, y, pose, seconds) {
      ctx.save();
      ctx.translate(x, y);
      ellipse(0, 0, 28, 7, '#29223655');
      const step = pose === 'walk' ? Math.sin(seconds * 15) * 4 : 0;
      if (pose === 'rest') { ctx.translate(-13, -8); ctx.rotate(-Math.PI / 2); ctx.scale(.74, .74); }
      if (['sit', 'read', 'watch'].includes(pose)) ctx.translate(0, 5);
      ctx.translate(0, pose === 'walk' ? -Math.abs(step) : Math.sin(seconds * 2.1) * 1.05);
      round(-16, -17, 12, 17 - step, 5, '#c7897d');
      round(5, -17, 12, 17 + step, 5, '#c7897d');
      round(-23, -42, 46, 31, 13, '#f1a98c');
      ellipse(-23, -92, 17, 25, '#4d466d'); ellipse(23, -92, 17, 25, '#4d466d');
      ellipse(0, -77, 30, 31, '#5c537d');
      ellipse(0, -71, 24, 22, '#f9c9af');
      ellipse(-23, -70, 5, 7, '#f9c9af'); ellipse(23, -70, 5, 7, '#f9c9af');
      ellipse(-9, -89, 21, 12, '#615782'); ellipse(8, -88, 18, 11, '#615782');
      shape([[-23, -86], [-6, -87], [-20, -70]], '#615782');
      shape([[11, -89], [24, -89], [21, -70]], '#615782');
      const blink = pose === 'rest' || seconds % 5.8 > 5.64;
      for (const eye of [-9, 9]) ellipse(eye, -70, 2.3, blink ? .8 : 4, '#34283e');
      ellipse(-16, -62, 5, 2.5, '#eba198'); ellipse(16, -62, 5, 2.5, '#eba198');
      line([[-3, -62], [0, -60], [3, -62]], '#965c6a', 1.3);
      shape([[14, -97], [30, -103], [29, -91], [14, -95], [7, -88], [4, -101]], '#f5c283');
      ellipse(15, -95, 3.5, 3.5, '#e7a27a');
      round(-23, -33, 10, 17, 5, '#f9c9af'); round(14, -33, 10, 17, 5, '#f9c9af');
      if (pose === 'read') {
        shape([[-15, -36], [-1, -32], [15, -36], [12, -22], [-1, -19], [-12, -22]], '#eee1bb');
        line([[-1, -32], [-1, -20]], '#a8797c', 2);
      }
      ctx.restore();
    }

    function draw(at) {
      const now = new Date();
      ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      const hour = now.getHours() + now.getMinutes() / 60;
      room(hour, at / 1000);
      const progress = Math.min(1, Math.max(0, (at - movedAt) / 950));
      const curve = progress * progress * (3 - 2 * progress);
      position = from.map((value, index) => value + (destination[index] - value) * curve);
      xiaoman(...position, progress < 1 && from !== destination ? 'walk' : state.pose, at / 1000);
      const dim = (1 + Math.cos(hour / 24 * 2 * Math.PI)) * .07 + (state.pose === 'rest' ? .12 : 0);
      ctx.fillStyle = 'rgba(43,32,67,' + dim + ')';
      ctx.fillRect(0, 0, width, height);
      if (state.source === 'offline') {
        ctx.fillStyle = '#3b30401d'; ctx.fillRect(0, 0, width, height);
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
    document.addEventListener('visibilitychange', syncVisibility);
    canvas.addEventListener('click', event => {
      const bounds = canvas.getBoundingClientRect();
      const x = (event.clientX - bounds.left) * width / bounds.width;
      const y = (event.clientY - bounds.top) * height / bounds.height;
      if (x >= 88 && x <= 254 && y >= 84 && y <= 199) onAlbum();
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

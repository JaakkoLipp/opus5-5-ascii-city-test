// ============================================================================
// hud.js — terminal HUD drawn into the same character grid as the world
// ----------------------------------------------------------------------------
// Status bar (FPS, position, heading, district/block, time), control strip,
// crosshair + interaction prompt, message log, ASCII minimap, boot sequence
// and the "click to jack in" overlay. Everything is plain text written into
// the display buffers after the 3D pass, so it inherits the CRT treatment.
// ============================================================================
AC.HUD = (function () {
  'use strict';
  const Scr = AC.Screen;
  const { hash2 } = AC.util;
  const F = AC.World.F;
  const msgs = [];
  const DISTRICTS = ['KABUKI-7', 'NEO SHINJUKU', 'CHROME BAY', 'LOWER SPRAWL', 'NIGHT MARKET', 'OLD HARBOR', 'GLASS FLATS', 'DEADWIRE'];
  const AVES = ['KABUKI AVE', 'RONIN AVE', 'SPRAWL AVE', 'CIRCUIT AVE', 'LOTUS AVE', 'MERIDIAN AVE'];
  const STREETS = ['NEON ST', 'WIRE ST', 'CANAL ST', 'HALO ST', 'RUST ST', 'ECHO ST'];
  const mod = (a, n) => ((a % n) + n) % n;
  const pad = (n, w) => { const s = String(Math.abs(n)); return (n < 0 ? '-' : '') + '0'.repeat(Math.max(0, w - s.length)) + s; };

  function message(text, dur, col) { msgs.push({ text, t: 0, dur: dur || 3.2, col: col || 0 }); if (msgs.length > 4) msgs.shift(); }

  function location(W, p) {
    const x = p.x, y = p.y, ci = W.idx(x, y), f = W.flags[ci];
    const tx = p.tileX, ty = p.tileY;
    const ave = AVES[mod(tx, AVES.length)], st = STREETS[mod(ty, STREETS.length)];
    const district = DISTRICTS[Math.floor(hash2(Math.floor(tx / 2), Math.floor(ty / 2)) * DISTRICTS.length)];
    const block = String.fromCharCode(65 + mod(ty, 26)) + '-' + pad(mod(tx, 100), 2);
    let place;
    if (f & F.INTERIOR || f & F.DOOR) {
      const b = W.buildings[W.bld[ci]];
      place = b ? (b.displayName || b.name) : 'INTERIOR';
    } else if (x < 16 && y < 16) place = (x >= 3 && x < 13 && y >= 3 && y < 13) ? ave + ' x ' + st : 'CORNER ' + ave.split(' ')[0] + '/' + st.split(' ')[0];
    else if (x < 16) place = ave;
    else if (y < 16) place = st;
    else if (f & F.ALLEY) place = 'BACK ALLEY';
    else { const b = W.buildings[W.bld[ci]]; place = b ? b.name : 'BLOCK'; }
    return { district, block, place };
  }

  function heading(yaw) {
    let deg = Math.round(90 - yaw * 180 / Math.PI); // compass: 0 = north (+y)
    deg = mod(deg, 360);
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return pad(deg, 3) + ' ' + names[Math.round(deg / 45) % 8];
  }

  function draw(st, dt) {
    const s = Scr.scr, cols = s.cols, rows = s.rows;
    const P = st.env.phosphor;
    const fr = P[0] * 255, fg = P[1] * 255, fb = P[2] * 255;
    const T = (c, r, str, k, bg) => Scr.text(c, r, str, fr * (k || 1), fg * (k || 1), fb * (k || 1), bg ? bg[0] : undefined, bg ? bg[1] : undefined, bg ? bg[2] : undefined);
    const inv = [fr * 0.82, fg * 0.82, fb * 0.82];
    const loc = location(st.W, st.player);

    // ---- top status bar (inverse video)
    Scr.fill(0, 0, cols, 1, ' ', 0, 0, 0, inv[0], inv[1], inv[2]);
    const p = st.player;
    const left = ` NEON//GRID ▌ ${pad(Math.round(st.fps), 3)} FPS ▌ POS ${p.x.toFixed(1).padStart(5, '0')} ${p.y.toFixed(1).padStart(5, '0')} ▌ HDG ${heading(p.yaw)} ▌ ${loc.district} // BLOCK ${loc.block} // ${loc.place}`;
    const right = `${AC.Environment.timeString(st.env)} ${AC.Environment.phaseName(st.env)} ▌ ${st.env.rain > 0 ? (st.env.rain > 0.7 ? 'HEAVY RAIN' : 'RAIN') : 'DRY'} `;
    Scr.text(0, 0, left.slice(0, Math.max(0, cols - right.length - 1)), 0, 0, 0, inv[0], inv[1], inv[2]);
    Scr.text(cols - right.length, 0, right, 0, 0, 0, inv[0], inv[1], inv[2]);

    // ---- bottom control strip
    Scr.fill(0, rows - 1, cols, 1, ' ', 0, 0, 0, fr * 0.16, fg * 0.16, fb * 0.16);
    const ctl = ' [WASD] MOVE  [MOUSE] LOOK  [SHIFT] SPRINT  [E] INTERACT  [ESC] RELEASE  ▌ [T] TIME  [R] RAIN  [P] PHOSPHOR  [M] MAP  [-/=] RES  [G] GLOW  [H] HELP';
    const info = `${s.cols}x${s.rows} ${st.stats.threads > 1 ? st.stats.threads + 'T ' : ''}${st.stats.rayMs.toFixed(1)}ms `;
    Scr.text(0, rows - 1, ctl.slice(0, Math.max(0, cols - info.length - 1)), fr * 0.85, fg * 0.85, fb * 0.85, fr * 0.16, fg * 0.16, fb * 0.16);
    Scr.text(cols - info.length, rows - 1, info, fr * 0.5, fg * 0.5, fb * 0.5, fr * 0.16, fg * 0.16, fb * 0.16);

    // ---- crosshair + prompt
    const cx = cols >> 1, cy = rows >> 1;
    T(cx, cy, '+', 0.55);
    if (st.prompt) {
      const txt = '[E] ' + st.prompt;
      T(cx - (txt.length >> 1), cy + 2, txt, 1.0, [0, 0, 0]);
    }

    // ---- messages
    let row = rows - 3;
    for (let k = msgs.length - 1; k >= 0; k--) {
      const m = msgs[k];
      m.t += dt;
      if (m.t > m.dur) { msgs.splice(k, 1); continue; }
      const a = Math.min(1, (m.dur - m.t) * 2) * Math.min(1, m.t * 8);
      const txt = '> ' + m.text + (m.t < 0.6 && (m.t * 10 | 0) & 1 ? '_' : ' ');
      const c = m.col ? AC.ACCENT[m.col] : P;
      Scr.text(cx - (txt.length >> 1), row, txt, c[0] * 255 * a, c[1] * 255 * a, c[2] * 255 * a, 0, 0, 0);
      row--;
    }

    if (st.mapOn) minimap(st, cols - 30, 2, 28, 13, fr, fg, fb);
    if (st.helpOn) help(st, fr, fg, fb);
    if (st.boot < 3.2) boot(st, fr, fg, fb);
    else if (!st.locked) overlay(st, fr, fg, fb);
  }

  function box(c0, r0, w, h, fr, fg, fb, title) {
    const bg = [0, 0, 0];
    Scr.fill(c0, r0, w, h, ' ', 0, 0, 0, bg[0], bg[1], bg[2]);
    const k = 0.7;
    Scr.text(c0, r0, '┌' + '─'.repeat(w - 2) + '┐', fr * k, fg * k, fb * k);
    Scr.text(c0, r0 + h - 1, '└' + '─'.repeat(w - 2) + '┘', fr * k, fg * k, fb * k);
    for (let r = r0 + 1; r < r0 + h - 1; r++) { Scr.text(c0, r, '│', fr * k, fg * k, fb * k); Scr.text(c0 + w - 1, r, '│', fr * k, fg * k, fb * k); }
    if (title) Scr.text(c0 + 2, r0, ' ' + title + ' ', fr, fg, fb);
  }

  function minimap(st, c0, r0, w, h, fr, fg, fb) {
    const W = st.W, p = st.player, S = W.S;
    box(c0, r0, w, h, fr, fg, fb, 'MAP');
    const sxs = 2.2, sys = 4.0;
    const cars = st.ents.cars, peds = st.ents.peds;
    for (let r = 1; r < h - 1; r++) for (let c = 1; c < w - 1; c++) {
      const wx = p.x + (c - w / 2) * sxs, wy = p.y + (h / 2 - r) * sys;
      const ci = W.idx(wx, wy), f = W.flags[ci];
      let ch = ' ', k = 0.3;
      if (f & F.INTERIOR) { ch = '+'; k = 0.5; }
      else if (f & F.DOOR) { ch = 'D'; k = 0.8; }
      else if (f & F.BUILDING) { ch = '#'; k = W.spanHi[ci] > 30 ? 0.55 : 0.35; }
      else if (f & F.SIDEWALK) { ch = '.'; k = 0.35; }
      else if (f & F.ALLEY) { ch = ':'; k = 0.3; }
      Scr.text(c0 + c, r0 + r, ch, fr * k, fg * k, fb * k);
    }
    const plot = (x, y, ch, col) => {
      const dx = AC.util.wrapDelta(x - p.x, S) / sxs + w / 2, dy = h / 2 - AC.util.wrapDelta(y - p.y, S) / sys;
      const c = Math.round(dx), r = Math.round(dy);
      if (c < 1 || c >= w - 1 || r < 1 || r >= h - 1) return;
      const a = AC.ACCENT[col];
      Scr.text(c0 + c, r0 + r, ch, a[0] * 255, a[1] * 255, a[2] * 255);
    };
    for (const c of cars) plot(c.x, c.y, 'o', c.paint || 3);
    for (const q of peds) if (q.visible) plot(q.x, q.y, '*', 1);
    const arrows = ['>', '/', '^', '\\', '<', '/', 'v', '\\'];
    const a = Math.round(((p.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (Math.PI / 4)) % 8;
    const ar = arrows[a];
    Scr.text(c0 + Math.round(w / 2), r0 + Math.round(h / 2), ar === '/' && (a === 5) ? '/' : ar, 255, 255, 255);
  }

  function help(st, fr, fg, fb) {
    const s = Scr.scr;
    const lines = [
      'WASD ........ move            MOUSE ....... look (click to lock)',
      'SHIFT ....... sprint          ARROWS ...... look (keyboard)',
      'E ........... interact / open doors / use machines',
      'ESC ......... release mouse   T / Y ....... time +1h / pause clock',
      'R ........... rain off/light/heavy   P ..... phosphor colour',
      'M ........... minimap         G ........... CRT glow',
      'F ........... phosphor trails  N .......... sound on/off',
      '- / = ....... character resolution (auto-adjusts to hold 60 FPS)',
      '',
      'Find the green-lit doors: NEON NOODLE and PIXEL PALACE are open.',
    ];
    const w = Math.min(s.cols - 4, 72), h = lines.length + 4;
    const c0 = (s.cols - w) >> 1, r0 = Math.max(2, (s.rows - h) >> 1);
    box(c0, r0, w, h, fr, fg, fb, 'HELP');
    lines.forEach((l, k) => Scr.text(c0 + 3, r0 + 2 + k, l.slice(0, w - 5), fr * 0.9, fg * 0.9, fb * 0.9));
  }

  const BOOT = [
    'NEON//GRID TERMINAL BIOS v1.0  (C) 2089 KIROSHI-SONY',
    'MEMORY TEST ............................ 640K OK',
    'MOUNTING SECTOR KABUKI-7 ............... OK',
    'RAYCAST CORE [2.5D DDA] ................ ONLINE',
    'GLYPH ATLAS ............................ ' + AC.Glyphs.count + ' CHARS',
    'PHOSPHOR ............................... WARM',
    'TRAFFIC / PEDESTRIAN AI ................ RUNNING',
    '',
    '>> LINK ESTABLISHED',
  ];
  function boot(st, fr, fg, fb) {
    const s = Scr.scr;
    const n = Math.min(BOOT.length, Math.floor(st.boot * 3.2));
    const w = Math.min(s.cols - 4, 64), h = BOOT.length + 4;
    const c0 = (s.cols - w) >> 1, r0 = Math.max(2, (s.rows - h) >> 1);
    const fade = st.boot > 2.8 ? 1 - (st.boot - 2.8) / 0.4 : 1;
    box(c0, r0, w, h, fr * fade, fg * fade, fb * fade, 'BOOT');
    for (let k = 0; k < n; k++) Scr.text(c0 + 3, r0 + 2 + k, BOOT[k].slice(0, w - 5), fr * fade, fg * fade, fb * fade);
    if (n < BOOT.length && (st.boot * 8 | 0) & 1) Scr.text(c0 + 3, r0 + 2 + n, '_', fr, fg, fb);
  }

  function overlay(st, fr, fg, fb) {
    const s = Scr.scr;
    const w = Math.min(s.cols - 4, 46), h = 7;
    const c0 = (s.cols - w) >> 1, r0 = ((s.rows - h) >> 1) - 5;
    box(c0, r0, w, h, fr, fg, fb, 'LINK IDLE');
    const blink = (st.time * 2 | 0) & 1;
    const t1 = blink ? '>> CLICK TO JACK IN <<' : '   CLICK TO JACK IN   ';
    Scr.text(c0 + ((w - t1.length) >> 1), r0 + 2, t1, fr, fg, fb);
    const t2 = 'WASD MOVE / MOUSE LOOK / E INTERACT';
    Scr.text(c0 + ((w - t2.length) >> 1), r0 + 4, t2.slice(0, w - 2), fr * 0.6, fg * 0.6, fb * 0.6);
  }

  return { draw, message, location };
})();

// ============================================================================
// main.js — boot, game loop, input actions, adaptive resolution
// ----------------------------------------------------------------------------
// Frame outline:
//   input -> player (variable dt) -> AI/traffic (fixed 120 Hz steps)
//   -> environment + sign/light animation -> emit dynamic entities
//   -> raycast + shade every character -> geometry edges -> particles
//   -> phosphor persistence -> HUD -> blit
// ============================================================================
AC.Main = (function () {
  'use strict';
  const { wrapDelta, RNG } = AC.util;
  const SEED = 2089;
  const FIXED = 1 / 120;

  let W, env, ents, player, canvas, glowEl, wrapEl;
  let last = 0, acc = 0, simTime = 0, frameNo = 0, time = 0, bootT = 0;
  const stats = { fps: 60, rayMs: 0, postMs: 0, blitMs: 0, workMs: 0, rays: 0, steps: 0, drawn: 0 };
  const opts = { mapOn: true, helpOn: false, charH: 18, minCharH: 14, autoRes: true, maxT: 105, forceLocked: false };
  let resTimer = 0, workAcc = 0, workN = 0, rainLevel = 1, actRng = new RNG(99);
  let glitch = { t: 0, row: 0, n: 0, k: 0 };
  const RAIN_LEVELS = [0, 0.45, 1];

  function boot() {
    canvas = document.getElementById('screen');
    glowEl = document.getElementById('glow');
    wrapEl = document.getElementById('wrap');
    W = AC.WorldGen.generate(SEED);
    env = AC.Environment.create();
    env.rain = RAIN_LEVELS[rainLevel];
    AC.Physics.init(W);
    AC.Raycaster.init(W);
    AC.Screen.init(canvas, glowEl);
    ents = new AC.Entities.System(W, SEED ^ 0x1234);
    player = new AC.Player(W, W.spawn);
    player.onStep = (sp) => AC.Audio.step(sp);
    AC.Particles.init(W, SEED ^ 0x777);
    AC.Input.init(canvas);
    // pick an initial character size from the window height (~60 rows at 1080p)
    opts.charH = Math.max(opts.minCharH, Math.min(24, Math.round(window.innerHeight / 60)));
    resize();
    window.addEventListener('resize', resize);
    AC.Shading.init(W, env, AC.Screen.scr);
    AC.HUD.message('WELCOME TO KABUKI-7. THE NOODLE BAR ACROSS THE STREET IS OPEN.', 7);
    exposeDebug();
    last = performance.now();
    requestAnimationFrame(loop);
  }

  function resize() {
    const CH = opts.charH, CW = Math.max(4, Math.round(CH * 0.56));
    const ww = window.innerWidth, wh = window.innerHeight;
    const cols = Math.max(40, Math.floor(ww / CW)), rows = Math.max(20, Math.floor(wh / CH));
    AC.Screen.configure(cols, rows, CW, CH);
    canvas.style.width = cols * CW + 'px'; canvas.style.height = rows * CH + 'px';
    wrapEl.style.width = cols * CW + 'px'; wrapEl.style.height = rows * CH + 'px';
  }

  // resolution changes are applied at the start of the next frame so the
  // freshly cleared canvas is immediately redrawn (no black flash)
  let pendingCharH = 0;
  function setCharH(h) {
    h = Math.max(10, Math.min(32, h));
    if (h === opts.charH) return;
    pendingCharH = h;
  }
  function applyPendingResize() {
    if (!pendingCharH) return;
    opts.charH = pendingCharH; pendingCharH = 0;
    resize();
  }

  // ------------------------------------------------------------ interaction
  const DRINKS = ['SYNTH-COLA', 'NEURO-FIZZ', 'KAIJU ENERGY', 'GREEN TEA (REAL?)', 'VOLT MILK', 'RAMUNE 2089'];
  const KIOSK = ['CITY INFO: CURFEW LIFTED IN SECTOR 7', 'WEATHER: ACID RAIN 80% // pH 4.1', 'LOST PET: CYBER-CAT "BYTE". REWARD.', 'METRO LINE 3 DELAYED: POWER GRID FAULT', 'HIRING: NIGHT SHIFT DATA JANITORS'];

  function findInteractable() {
    let best = null, bd = 2.3;
    for (const it of W.interactables) {
      const dx = wrapDelta(it.x - player.x, W.S), dy = wrapDelta(it.y - player.y, W.S);
      const d = Math.hypot(dx, dy);
      if (d > bd) continue;
      let a = Math.atan2(dy, dx) - player.yaw;
      a = Math.atan2(Math.sin(a), Math.cos(a));
      if (Math.abs(a) > 0.95 && d > 0.8) continue;
      best = it; bd = d;
    }
    return best;
  }
  function promptFor(it) {
    if (!it) return null;
    if (it.type === 'door') {
      const d = it.door, b = W.buildings[d.bld];
      if (d.locked) return 'DOOR - ' + (b ? b.name : '') + ' [LOCKED]';
      return (d.playerOpen ? 'CLOSE DOOR' : 'ENTER ' + (b && b.displayName ? b.displayName : 'BUILDING'));
    }
    if (it.type === 'vending') return 'BUY A DRINK';
    if (it.type === 'arcade') return 'PLAY';
    if (it.type === 'kiosk') return 'READ TERMINAL';
    return 'USE';
  }
  function interact(it) {
    if (!it) { AC.HUD.message('NOTHING TO INTERACT WITH', 1.5); return; }
    if (it.type === 'door') {
      const d = it.door, b = W.buildings[d.bld];
      if (d.locked) {
        AC.HUD.message('ACCESS DENIED // KEYCARD REQUIRED', 2.5, 4);
        AC.Audio.blip(160, 0.25);
        return;
      }
      d.playerOpen = !d.playerOpen;
      d.target = d.playerOpen ? 1 : 0;
      d.away = 0;
      AC.HUD.message(d.playerOpen ? 'ACCESS GRANTED // ' + (b.displayName || b.name) : 'DOOR CLOSED', 2.5, d.playerOpen ? 5 : 0);
      AC.Audio.blip(d.playerOpen ? 1320 : 660, 0.1);
    } else if (it.type === 'vending') {
      AC.HUD.message('DISPENSED: ' + actRng.pick(DRINKS) + ' // ' + (80 + actRng.int(0, 12) * 10) + ' CR', 2.5, 2);
      AC.Audio.blip(990, 0.08);
    } else if (it.type === 'arcade') {
      AC.HUD.message('INSERT COIN ... HI-SCORE ' + String(actRng.int(10000, 99999)) + ' BY "ZER0"', 2.5, 1);
      AC.Audio.blip(1760, 0.06);
    } else if (it.type === 'kiosk') {
      AC.HUD.message(actRng.pick(KIOSK), 3.5, 2);
      AC.Audio.blip(1200, 0.05);
    }
  }

  function handleKeys() {
    for (const k of AC.Input.pressed()) {
      switch (k) {
        case 'Click': AC.Audio.start(); AC.Audio.setRain(env.rain); break;
        case 'KeyE': interact(findInteractable()); break;
        case 'KeyT': env.hour = (env.hour + 1) % 24; AC.HUD.message('CLOCK ' + AC.Environment.timeString(env), 1.5); break;
        case 'KeyY': env.paused = !env.paused; AC.HUD.message(env.paused ? 'CLOCK PAUSED' : 'CLOCK RUNNING', 1.5); break;
        case 'KeyR':
          rainLevel = (rainLevel + 1) % 3; env.rain = RAIN_LEVELS[rainLevel]; AC.Audio.setRain(env.rain);
          AC.HUD.message(['RAIN OFF', 'LIGHT RAIN', 'HEAVY RAIN'][rainLevel], 1.5); break;
        case 'KeyP': AC.HUD.message('PHOSPHOR: ' + AC.Environment.setPalette(env, env.palette + 1), 1.5); break;
        case 'KeyM': opts.mapOn = !opts.mapOn; break;
        case 'KeyH': opts.helpOn = !opts.helpOn; break;
        case 'KeyG': AC.Screen.scr.glowOn = !AC.Screen.scr.glowOn; glowEl.style.display = AC.Screen.scr.glowOn ? '' : 'none'; AC.HUD.message('GLOW ' + (AC.Screen.scr.glowOn ? 'ON' : 'OFF'), 1.2); break;
        case 'KeyF': AC.Screen.scr.persist = !AC.Screen.scr.persist; AC.HUD.message('PHOSPHOR TRAILS ' + (AC.Screen.scr.persist ? 'ON' : 'OFF'), 1.2); break;
        case 'KeyN': AC.HUD.message('SOUND ' + (AC.Audio.toggle() ? 'ON' : 'OFF'), 1.2); break;
        case 'KeyV': env.debugView = !env.debugView; break;
        case 'KeyB': AC.Screen.scr.edgeOn = !AC.Screen.scr.edgeOn; AC.HUD.message('EDGE PASS ' + (AC.Screen.scr.edgeOn ? 'ON' : 'OFF'), 1.2); break;
        case 'Minus': opts.autoRes = false; setCharH(opts.charH + 2); AC.HUD.message('RES ' + AC.Screen.scr.cols + 'x' + AC.Screen.scr.rows + ' (AUTO OFF)', 1.5); break;
        case 'Equal': opts.autoRes = false; setCharH(opts.charH - 2); AC.HUD.message('RES ' + AC.Screen.scr.cols + 'x' + AC.Screen.scr.rows + ' (AUTO OFF)', 1.5); break;
      }
    }
  }

  // --------------------------------------------------------- adaptive res
  function adaptResolution(dt, work) {
    if (!opts.autoRes || bootT < 2) return;
    workAcc += work; workN++;
    resTimer += dt;
    if (resTimer < 1.5) return;
    const avg = workAcc / workN;
    resTimer = 0; workAcc = 0; workN = 0;
    if (avg > 13.5 || stats.fps < 50) setCharH(opts.charH + 2);
    else if (avg < 6.5 && stats.fps > 57 && opts.charH > opts.minCharH) setCharH(opts.charH - 2);
  }

  // -------------------------------------------------------------- the loop
  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000; last = now;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;
    frame(dt);
  }

  function frame(dt) {
    time += dt; bootT += dt;
    applyPendingResize();
    const t0 = performance.now();
    handleKeys();
    player.update(dt, AC.Input, ents.colliders);
    AC.Input.endFrame();

    acc += dt;
    let n = 0;
    while (acc >= FIXED && n < 14) { AC.AI.step(ents, env, player, FIXED, simTime); simTime += FIXED; acc -= FIXED; n++; }
    if (n >= 14) acc = 0;
    AC.Environment.update(env, dt, simTime, frameNo);
    AC.AI.animate(W, env, simTime);

    const cam = player.camera();
    ents.emit(simTime, env, cam);
    AC.Particles.update(dt, cam, env, simTime);

    const scr = AC.Screen.scr;
    AC.Shading.beginFrame(simTime, frameNo, cam, opts.maxT);
    const t1 = performance.now();
    AC.Raycaster.castFrame(cam, scr, 1, scr.rows - 1, opts.maxT, AC.Shading.shade);
    const t2 = performance.now();
    if (scr.edgeOn) AC.Screen.edges(1, scr.rows - 1, 34, 0.2);
    AC.Particles.render(scr, cam, env, frameNo);
    AC.Screen.compose(dt);
    glitchPass(dt);
    const it = findInteractable();
    AC.HUD.draw({
      W, env, player, ents, fps: stats.fps, stats, prompt: promptFor(it), locked: AC.Input.locked || opts.forceLocked,
      mapOn: opts.mapOn, helpOn: opts.helpOn, boot: bootT, time,
    }, dt);
    const t3 = performance.now();
    stats.drawn = AC.Screen.present();
    const t4 = performance.now();

    const k = 0.08;
    stats.rayMs += (t2 - t1 - stats.rayMs) * k;
    stats.postMs += (t3 - t2 - stats.postMs) * k;
    stats.blitMs += (t4 - t3 - stats.blitMs) * k;
    stats.workMs += (t4 - t0 - stats.workMs) * k;
    stats.fps += (1 / dt - stats.fps) * 0.05;
    stats.rays = AC.Raycaster.stats.rays; stats.steps = AC.Raycaster.stats.steps;
    adaptResolution(dt, t4 - t0);
    frameNo++;
  }

  // occasional horizontal tearing of a few rows, like a bad VGA cable
  function glitchPass(dt) {
    const scr = AC.Screen.scr;
    if (glitch.t > 0) {
      glitch.t -= dt;
      const cols = scr.cols;
      for (let r = glitch.row; r < glitch.row + glitch.n && r < scr.rows - 1; r++) {
        const base = r * cols;
        for (const arr of [scr.dGlyph, scr.dR, scr.dG, scr.dB]) {
          const tmp = arr.slice(base, base + cols);
          for (let c = 0; c < cols; c++) arr[base + c] = tmp[(c - glitch.k + cols) % cols];
        }
      }
    } else if (AC.util.hash1(frameNo * 31 + 7) < 0.004) {
      glitch.t = 0.05 + AC.util.hash1(frameNo) * 0.1;
      glitch.row = 1 + Math.floor(AC.util.hash1(frameNo + 1) * (scr.rows - 4));
      glitch.n = 1 + Math.floor(AC.util.hash1(frameNo + 2) * 3);
      glitch.k = 1 + Math.floor(AC.util.hash1(frameNo + 3) * 4);
    }
  }

  // ---------------------------------------------------------------- debug
  function exposeDebug() {
    window.__AC = {
      W, env, ents, player, stats, opts,
      setPose(x, y, yaw, pitch) { player.x = x; player.y = y; player.yaw = yaw; player.pitch = pitch || 0; player.zFeet = AC.Physics.groundAt(x, y); player.vx = player.vy = 0; },
      setHour(h) { env.hour = h; },
      setRain(r) { env.rain = r; },
      setCharH(h) { opts.autoRes = false; setCharH(h); applyPendingResize(); },
      advance(sec) { const n = Math.round(sec / FIXED); for (let i = 0; i < n; i++) { AC.AI.step(ents, env, player, FIXED, simTime); simTime += FIXED; } },
      frame(dt) { frame(dt || 1 / 60); },
      text() {
        const s = AC.Screen.scr, L = AC.Glyphs.list;
        let out = '';
        for (let r = 0; r < s.rows; r++) { let line = ''; for (let c = 0; c < s.cols; c++) line += L[s.dGlyph[r * s.cols + c]]; out += line + '\n'; }
        return out;
      },
      interact() { interact(findInteractable()); },
      scr: AC.Screen.scr,
      set(path, v) { const ks = path.split('.'); let o = window.__AC; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = v; },
      prompt() { return promptFor(findInteractable()); },
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  return { stats, opts };
})();
